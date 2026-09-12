import fs from 'fs';
import * as readline from 'node:readline/promises';
import type { Command } from 'commander';
import type { RunOptions } from '../runtime/index.js';
import { resolveRuntime, RUNTIME_NAMES } from '../runtime/registry.js';
import { defaultWorktreesDir } from '../runs/worktreesDir.js';
import { HostGit } from '../git/host.js';
import { HostPullRequest } from '../github/host.js';
import {
  resolveSpawnTarget,
  validateSpawn,
  planSpawn,
  type SpawnFacts,
} from './spawnPlan.js';
import { resolveHarness, HARNESSES } from '../harness/index.js';
import { findAgent, isKnownTarget } from '../agent/index.js';
import { parseDotenv } from '../utils/dotenv.js';
import {
  ensureShippedSkill,
  resolveSkill,
  parseSkillList,
} from '../skill/index.js';
import {
  readMcpServer,
  listMcpServerNames,
  type McpServer,
} from '../mcp/index.js';
import { RunScratch } from '../runs/runScratch.js';
import {
  LocalApiKeyError,
  createLocalApiKey,
  needsLocalApiKey,
  providerTargetsLocalStack,
  upsertEnvValue,
} from './localApiKey.js';
import { executeSpawn } from './executeSpawn.js';
import { findRoot } from '../store/root.js';
import { envFilePath, egressBlacklistPath } from '../store/paths.js';
import { readConfig } from '../store/config.js';
import { localStack } from '../runtime/stack.js';

import { log } from '../utils/log.js';
import { env } from '../utils/env.js';
import { siblingSummaryLine } from '../runs/runSiblings.js';
import { mergeLanded } from '../runs/runMergeBack.js';

/** The parsed `e spawn` CLI options, as Commander hands them to the action. */
export interface SpawnCommandOptions extends Omit<RunOptions, 'envFile'> {
  runtime?: string;
  rebuild?: boolean;
  dir?: string;
  /** Raw `--env-file <path>` value from the CLI (a single path). */
  envFile?: string;
  /** `--mcp <name...>`: MCP servers to wire for this run (container sidecars and/or remote URLs). */
  mcp?: string[];
  /** `--skill <name...>`: Skills to add for this run (comma-separated or repeated). */
  skill?: string[];
  /** `--detached`: run a one-shot detached prompt instead of starting the interactive TUI. */
  detached?: boolean;
  /** `--keep-worktree`: leave the run's worktree in place after the container exits. */
  keepWorktree?: boolean;
}

/**
 * Reads the store's shared `.e/.env` into a key→value map, for resolving a
 * provider's `apiKeyEnv` by name. This is the sole source of a provider's API
 * key (ADR-0006); a missing or unreadable file yields an empty map, so an unset
 * key surfaces as the adapter's clear "add it to .e/.env" error.
 */
function loadStoreEnv(baseEnvFile: string | undefined): Record<string, string> {
  if (baseEnvFile === undefined || !fs.existsSync(baseEnvFile)) return {};
  return parseDotenv(fs.readFileSync(baseEnvFile, 'utf8'));
}

/**
 * Gets the OmniRoute endpoint API key the agent needs and records it in the
 * store env under the provider's `apiKeyEnv`. First choice is to create one
 * through OmniRoute's own API with the stack password (no interaction); when
 * that login fails, the user is walked through the dashboard instead.
 */
async function obtainLocalApiKey(
  envFile: string,
  initialPassword: string,
  apiKeyEnv: string,
  agentName: string
): Promise<string> {
  if (initialPassword) {
    try {
      const key = await createLocalApiKey({
        baseUrl: env.omniRoutedUrl,
        password: initialPassword,
        name: `e (${agentName})`,
      });
      const content = fs.existsSync(envFile)
        ? fs.readFileSync(envFile, 'utf8')
        : '';
      fs.writeFileSync(envFile, upsertEnvValue(content, apiKeyEnv, key));
      log.success(
        `Created an OmniRoute API key for this agent and saved it as ${apiKeyEnv} in .e/.env.`
      );
      return key;
    } catch (error) {
      const reason =
        error instanceof LocalApiKeyError
          ? error.message
          : `OmniRoute is not reachable at ${env.omniRoutedUrl}: ${(error as Error).message}`;
      log.warn(
        `Could not create an OmniRoute API key automatically (${reason}). If the stack was set up with a different OMNIROUTE_INITIAL_PASSWORD, restore it in .e/.env or remove the omniroute-data volume to reset the dashboard login.`
      );
    }
  }
  return promptForLocalApiKey(envFile, initialPassword, apiKeyEnv);
}

async function promptForLocalApiKey(
  envFile: string,
  initialPassword: string,
  apiKeyEnv: string
): Promise<string> {
  log.info(
    '\nOmniRoute needs an endpoint API key before `auto` model discovery can run.'
  );
  log.info(`1. Open ${env.omniRoutedUrl} in your browser.`);
  log.info(
    initialPassword
      ? `2. Sign in with the local password: ${initialPassword}`
      : '2. Sign in with the password in `OMNIROUTE_INITIAL_PASSWORD` in `.e/.env` (run `e init` to generate one).'
  );
  log.info(
    `3. ${env.omniRoutedUrl}/dashboard/api-manager → Create API Key → Copy the key and paste it below.`
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    for (;;) {
      const key = (await rl.question('OmniRoute API key: ')).trim();
      if (key) {
        // Only the provider's own key variable: another agent's hosted key in
        // the same .e/.env must survive this handshake untouched.
        const content = fs.existsSync(envFile)
          ? fs.readFileSync(envFile, 'utf8')
          : '';
        fs.writeFileSync(envFile, upsertEnvValue(content, apiKeyEnv, key));
        return key;
      }
      log.warn('API key cannot be blank.');
    }
  } finally {
    rl.close();
  }
}

async function localApiKeyIsAccepted(key: string): Promise<boolean> {
  try {
    const response = await fetch(`${env.omniRoutedUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    return response.status !== 401;
  } catch {
    return true;
  }
}

/**
 * Resolves a requested `--mcp <name>` to its persisted definition, throwing a
 * clear error (listing the available servers) when it isn't there. A malformed
 * `mcp.json` surfaces as the parse error from {@link readMcpServer}.
 */
function resolveMcpServer(name: string, root: string | undefined): McpServer {
  const server = readMcpServer(name, root);
  if (server) return server;
  const available = listMcpServerNames(root);
  const list = available.length ? available.join(', ') : '(none)';
  throw new Error(
    `Unknown MCP server "${name}". Available: ${list}. ` +
      `Add one under .e/mcp/<name>/ (an mcp.json, plus a Dockerfile for a container server) or run \`e init\`.`
  );
}

/**
 * Gathers everything a spawn's decisions need from disk and the CLI args into a
 * pure {@link SpawnFacts} value - the single I/O step before the pure pipeline
 * ({@link validateSpawn} → resolve model → {@link planSpawn} → executeSpawn). It
 * resolves the Agent, the Harness, the store env, and every requested MCP server
 * and skill *now* (existence checked, throwing a clear error), so a bad name
 * fails fast - before the model fetch, any build, or a worktree. The resolved
 * model is *not* gathered here (it needs a network call - see the action).
 * Exported for its tests; the action is its only production caller.
 */
export function gatherSpawnFacts(
  target: string | undefined,
  prompt: string[],
  opts: SpawnCommandOptions
): SpawnFacts {
  const root = findRoot(opts.dir);
  const config = readConfig(root);
  const defaultHarness = config.defaultHarness;

  // The target is an agent/harness name resolved directly (a bare harness →
  // its default agent).
  const resolved = resolveSpawnTarget({
    target,
    prompt,
    defaultHarness,
    isKnownTarget: name => isKnownTarget(name, root),
  });
  const agent = findAgent(resolved.agentTarget, root);
  const harness = resolveHarness(agent.harness);

  const baseEnvPath = root !== undefined ? envFilePath(root) : undefined;
  const mcpNames = opts.mcp ?? [];
  // The shared `.e/.env` is the sole source of a provider's API key and any MCP
  // credential (ADR-0006) - read once, only when something needs it.
  const needStoreEnv = Boolean(agent.provider) || mcpNames.length > 0;
  const storeEnv = needStoreEnv ? loadStoreEnv(baseEnvPath) : {};

  // Resolve requested MCP servers and skills from disk now (existence checked).
  const mcpServers = mcpNames.map(name => resolveMcpServer(name, root));
  const perRunSkills = parseSkillList(opts.skill ?? []);
  const bakedSkills = agent.skills ?? [];
  for (const name of new Set([...bakedSkills, ...perRunSkills])) {
    // A shipped skill missing from an older store is seeded on the spot.
    ensureShippedSkill(name, root);
    resolveSkill(name, root);
  }

  const detached = Boolean(opts.detached);
  if (detached && !resolved.prompt.length) {
    throw new Error('A prompt is required for detached runs.');
  }

  return {
    root,
    agent,
    harness,
    storeEnv,
    mcpServers,
    perRunSkills,
    bakedSkills,
    prompt: resolved.prompt.join(' '),
    rebuild: Boolean(opts.rebuild),
    name: opts.name,
    env: opts.env ?? [],
    port: opts.port,
    detached,
    headlessTty: env.headlessTty,
    rm: opts.rm,
    keepWorktree: Boolean(opts.keepWorktree),
    // Layer the shared base only when it exists on disk (ADR-0006).
    baseEnvFile:
      baseEnvPath !== undefined && fs.existsSync(baseEnvPath)
        ? baseEnvPath
        : undefined,
    // The egress blacklist source is host-editable and lives in the store
    // (ADR-0011); undefined when there is no store root.
    egressBlacklistFile:
      root === undefined ? undefined : egressBlacklistPath(root),
    userEnvFile: opts.envFile,
    dirOpt: opts.dir,
    // Platform default or `E_WORKTREES_DIR`; a path the engine can bind-mount.
    worktreesDir: defaultWorktreesDir(),
    // `parent` unless the `E_SPAWN_ROLE` marker says `child` (ADR-0013).
    role: env.spawnRole,
    // Set by a parent run's host for a sibling request (ADR-0013).
    sibling: env.sibling,
    // The store's sibling settings, read once with the rest of config.json.
    siblingArtifacts: config.siblingArtifacts,
    maxSiblings: config.maxSiblings,
  };
}

export function registerSpawnCommand(program: Command): void {
  program
    .command('spawn')
    .description('Build and run a coding harness in a container')
    .argument(
      '[target]',
      `agent or harness to run (harnesses: ${Object.keys(HARNESSES).join(', ')})`
    )
    .argument('[prompt...]', 'instruction passed to the harness')
    .option(
      '--runtime <runtime>',
      `container runtime to use: ${RUNTIME_NAMES.join(', ')} (default: $E_RUNTIME, else the first one on PATH)`
    )
    .option(
      '--name <name>',
      'name for the run (overrides the prompt-derived slug)'
    )
    .option('--env-file <path>', 'load environment variables from a file')
    .option(
      '--mcp <name...>',
      'MCP server(s) to wire for this run - container (sidecar) or remote (hosted URL); repeatable'
    )
    .option(
      '--skill <name...>',
      'Skill(s) to add for this run, from .e/skills (comma-separated or repeated)'
    )
    .option('--rebuild', 'force a rebuild of the harness image', false)
    .option(
      '--dir <path>',
      'root directory holding the harness Dockerfiles (default: home directory)'
    )
    .option(
      '-d, --detached',
      'run a one-shot detached prompt instead of starting the interactive TUI'
    )
    .option('--rm', 'automatically remove the container when it exits', true)
    .option('--no-rm', 'keep the container after it exits')
    .option('--keep-worktree', 'keep the worktree after container exits')
    .option(
      '-p, --port <port...>',
      'publish a container port, e.g. 8080:80 (repeatable)'
    )
    .option(
      '-e, --env <env...>',
      'set an environment variable, e.g. KEY=value (repeatable)'
    )
    .action(
      async (
        target: string | undefined,
        prompt: string[],
        opts: SpawnCommandOptions
      ) => {
        // The whole spawn: gather facts (I/O) → validate (pure, fail-fast) →
        // resolve the model (the one remaining I/O) → plan (pure) → execute. One
        // RunScratch owns every rendered secret file; one dispose() cleans up, and
        // one try/catch turns any failure into a clean exit (ADR-0008).
        const scratch = new RunScratch();
        // A sibling its parent's host gives up on gets SIGTERM; drop the
        // rendered secret files before exiting (Node's default would exit
        // without running any cleanup).
        process.once('SIGTERM', () => {
          scratch.dispose();
          process.exit(143);
        });
        try {
          const facts = gatherSpawnFacts(target, prompt, opts);
          validateSpawn(facts);
          const runtime = resolveRuntime(opts.runtime);
          const stack = localStack(facts.root);
          facts.localStackPresent = Boolean(stack?.present);
          const localRuntimes = readConfig(facts.root).localRuntimes;
          if (stack?.present) {
            // The stack is interpolated from `.e/.env` (no fallback secrets), so
            // pass it explicitly - compose does not otherwise look inside `.e/`.
            runtime.composeUp(
              stack.composeFile,
              stack.envFile,
              localRuntimes.length > 0
            );
            // Local runtime stacks wait for bootstrap model registration; empty
            // selections intentionally render no bootstrap service.
          }

          // A provider that points at the local OmniRoute needs an endpoint
          // API key; unconfigured means empty or still the generated initial
          // password. Hosted providers are never asked (see localApiKey.ts).
          const provider = facts.agent.provider;
          const configuredApiKey = provider
            ? (facts.storeEnv[provider.apiKeyEnv] ?? '')
            : '';
          const stackPassword = facts.storeEnv.OMNIROUTE_INITIAL_PASSWORD ?? '';
          const accepted =
            provider &&
            facts.localStackPresent &&
            providerTargetsLocalStack(provider) &&
            configuredApiKey !== '' &&
            configuredApiKey !== stackPassword
              ? await localApiKeyIsAccepted(configuredApiKey)
              : true;
          if (
            provider &&
            needsLocalApiKey({
              stackPresent: facts.localStackPresent,
              provider,
              configuredKey: configuredApiKey,
              stackPassword,
              accepted,
            })
          ) {
            const key = await obtainLocalApiKey(
              facts.baseEnvFile ?? envFilePath(facts.root),
              stackPassword,
              provider.apiKeyEnv,
              facts.agent.name
            );
            facts.storeEnv[provider.apiKeyEnv] = key;
          }

          const plan = planSpawn(facts);
          const config = readConfig(facts.root);
          const result = await executeSpawn(facts, plan, {
            git: new HostGit(),
            runtime,
            scratch,
            pullRequest: config.gitPlatform ? new HostPullRequest() : undefined,
            gitPlatform: config.gitPlatform,
          });

          // Rendered env-files hold resolved secrets; each container already has
          // its own copy, so drop them before reporting and exiting. This is
          // independent of --keep-worktree, which only concerns the worktree.
          scratch.dispose();

          if (result.error) {
            log.error(result.error);
            process.exit(result.exitCode);
          }
          if (result.pushWarning) {
            log.warn(`Warning: ${result.pushWarning}`);
          }
          if (result.pushed) {
            log.success('Pushed to origin. Open a PR or merge when you like.');
          }
          if (result.pullRequestUrl) {
            log.success(`Pull request: ${result.pullRequestUrl}`);
          }
          // Siblings this run requested and how their work came back (ticket 07).
          for (const sibling of result.siblings ?? []) {
            const line = siblingSummaryLine(sibling);
            if (mergeLanded(sibling.merge)) log.info(line);
            else log.warn(line);
          }
          if (result.pullRequestWarning) {
            log.warn(`Warning: ${result.pullRequestWarning}`);
          }
          log.success(`\nRun branch: ${result.branch}`);
          if (result.captured) {
            log.success('Captured uncommitted changes in a host commit.');
          }
          process.exit(result.exitCode);
        } catch (err) {
          scratch.dispose();
          log.error((err as Error).message);
          process.exit(1);
        }
      }
    );
}
