import fs from 'fs';
import * as readline from 'node:readline/promises';
import type { Command } from 'commander';
import { ContainerRuntime, type RunOptions } from './runtime/index';
import { HostGit } from './git/host';
import {
  resolveSpawnTarget,
  validateSpawn,
  planSpawn,
  type SpawnFacts,
} from './spawnPlan';
import { resolveHarness, HARNESSES } from './harness/index';
import { findAgent, isKnownTarget } from './agent';
import { parseDotenv } from './harness/adapter';
import { resolveSkill, parseSkillList } from './skill/index';
import { readMcpServer, listMcpServerNames, type McpServer } from './mcp/index';
import { RunScratch } from './runScratch';
import { executeSpawn } from './executeSpawn';
import {
  findRoot,
  envFilePath,
  readConfig,
  dockerComposePath,
} from './store';
import { log } from './utils/log';
import { waitForModelsReady } from './modelStatus';

/** Host-published port of the local llama.cpp router (see `renderCompose`). */
const LOCAL_LLAMA_URL = process.env.LOCAL_LLAMA_URL ?? 'http://127.0.0.1:9931';

/** Available runtimes, mapping name → executable, in auto-detection order. */
const RUNTIMES: Record<string, string> = {
  docker: 'docker',
  podman: 'podman',
};

/**
 * Resolves which container runtime to use.
 * If `preferred` is given, it must be a known runtime and be available.
 * Otherwise the first available runtime is returned (docker preferred over podman).
 */
export function resolveRuntime(preferred?: string): ContainerRuntime {
  if (preferred) {
    const command = RUNTIMES[preferred];
    if (!command) {
      throw new Error(
        `Invalid runtime "${preferred}". Valid values: ${Object.keys(RUNTIMES).join(', ')}.`
      );
    }
    const runtime = new ContainerRuntime(command);
    if (!runtime.isAvailable()) {
      throw new Error(
        `Requested runtime "${preferred}" is not installed or not on PATH.`
      );
    }
    return runtime;
  }

  for (const command of Object.values(RUNTIMES)) {
    const runtime = new ContainerRuntime(command);
    if (runtime.isAvailable()) {
      return runtime;
    }
  }

  throw new Error(
    `No container runtime found. Install docker or podman, or make sure it is on PATH.`
  );
}

interface SpawnCommandOptions extends Omit<RunOptions, 'envFile'> {
  runtime?: string;
  rebuild?: boolean;
  dir?: string;
  /** Raw `--env-file <path>` value from the CLI (a single path). */
  envFile?: string;
  /** `--mcp <name...>`: MCP servers to wire for this run (container sidecars and/or remote URLs). */
  mcp?: string[];
  /** `--skill <name...>`: Skills to add for this run (comma-separated or repeated). */
  skill?: string[];
  /** `--interactive`: start the harness's terminal UI. */
  interactive?: boolean;
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

async function promptForLocalApiKey(envFile: string): Promise<string> {
  log.info(
    '\nOmniRoute needs an endpoint API key before `auto` model discovery can run.'
  );
  log.info('1. Open http://localhost:20128 in your browser.');
  log.info('2. Sign in with the local password: local-development');
  log.info('3. http://localhost:20128/dashboard/api-manager → Create API Key → Copy the key and paste it below.');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    for (;;) {
      const key = (await rl.question('OmniRoute API key: ')).trim();
      if (key) {
        const content = fs.readFileSync(envFile, 'utf8');
        const updated = content
          .replace(/^OPENAI_API_KEY=.*$/m, `OPENAI_API_KEY=${key}`)
          .replace(/^ANTHROPIC_API_KEY=.*$/m, `ANTHROPIC_API_KEY=${key}`);
        fs.writeFileSync(envFile, updated);
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
    const response = await fetch('http://127.0.0.1:20128/v1/models', {
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
 * pure {@link SpawnFacts} value — the single I/O step before the pure pipeline
 * ({@link validateSpawn} → resolve model → {@link planSpawn} → executeSpawn). It
 * resolves the Agent, the Harness, the store env, and every requested MCP server
 * and skill *now* (existence checked, throwing a clear error), so a bad name
 * fails fast — before the model fetch, any build, or a worktree. The resolved
 * model is *not* gathered here (it needs a network call — see the action).
 */
function gatherSpawnFacts(
  target: string | undefined,
  prompt: string[],
  opts: SpawnCommandOptions
): SpawnFacts {
  const root = findRoot(opts.dir);
  const defaultHarness = readConfig(root).defaultHarness;

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
  // credential (ADR-0006) — read once, only when something needs it.
  const needStoreEnv = Boolean(agent.provider) || mcpNames.length > 0;
  const storeEnv = needStoreEnv ? loadStoreEnv(baseEnvPath) : {};

  // Resolve requested MCP servers and skills from disk now (existence checked).
  const mcpServers = mcpNames.map(name => resolveMcpServer(name, root));
  const perRunSkills = parseSkillList(opts.skill ?? []);
  const bakedSkills = agent.skills ?? [];
  for (const name of new Set([...bakedSkills, ...perRunSkills])) {
    resolveSkill(name, root);
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
    attach: opts.attach,
    interactive: Boolean(opts.interactive),
    rm: opts.rm,
    // Layer the shared base only when it exists on disk (ADR-0006).
    baseEnvFile:
      baseEnvPath !== undefined && fs.existsSync(baseEnvPath)
        ? baseEnvPath
        : undefined,
    userEnvFile: opts.envFile,
    dirOpt: opts.dir,
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
      'container runtime to use (docker or podman)'
    )
    .option(
      '--name <name>',
      'name for the run (overrides the prompt-derived slug)'
    )
    .option('--env-file <path>', 'load environment variables from a file')
    .option(
      '--mcp <name...>',
      'MCP server(s) to wire for this run — container (sidecar) or remote (hosted URL); repeatable'
    )
    .option(
      '--skill <name...>',
      'Skill(s) to add for this run, from .e/skills (comma-separated or repeated)'
    )
    .option('--rebuild', 'force a rebuild of the harness image', false)
    .option(
      '-i, --interactive',
      'start the harness terminal UI instead of running a one-shot prompt',
      false
    )
    .option(
      '--dir <path>',
      'root directory holding the harness Dockerfiles (default: home directory)'
    )
    .option('-a, --attach', 'run the container in the foreground', true)
    .option(
      '--no-attach',
      'run detached (unsupported with per-run worktrees; run in the foreground)'
    )
    .option('--rm', 'automatically remove the container when it exits', true)
    .option('--no-rm', 'keep the container after it exits')
    .option(
      '--rm-worktree',
      'automatically remove the worktree when it exits',
      true
    )
    .option('--no-rm-worktree', 'keep the worktree after container exits')
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
        try {
          const facts = gatherSpawnFacts(target, prompt, opts);
          validateSpawn(facts);
          const runtime = resolveRuntime(opts.runtime);
          const composeFile = dockerComposePath(facts.root);
          if (fs.existsSync(composeFile)) {
            runtime.composeUp(composeFile);
            await waitForModelsReady({
              baseUrl: LOCAL_LLAMA_URL,
              models: readConfig(facts.root).models,
            });
          }

          const configuredApiKey = facts.agent.provider
            ? facts.storeEnv[facts.agent.provider.apiKeyEnv] ?? ''
            : '';
          if (
            facts.agent.provider &&
            (['', 'local-development'].includes(configuredApiKey) ||
              !(await localApiKeyIsAccepted(configuredApiKey)))
          ) {
            const key = await promptForLocalApiKey(
              facts.baseEnvFile ?? envFilePath(facts.root)
            );
            facts.storeEnv[facts.agent.provider.apiKeyEnv] = key;
          }

          const plan = planSpawn(facts);
          const result = await executeSpawn(facts, plan, {
            git: new HostGit(),
            runtime,
            scratch,
          });
          // Rendered env-files hold resolved secrets; each container already has
          // its own copy, so drop them before reporting and exiting.
          if (opts.rmWorktree === true) {
            scratch.dispose();
          }

          if (result.error) {
            log.error(result.error);
            process.exit(result.exitCode);
          }
          for (const warning of result.sidecarWarnings ?? []) {
            log.warn(`Warning: ${warning}`);
          }
          if (result.pushWarning) {
            log.warn(`Warning: ${result.pushWarning}`);
          }
          log.success(`\nRun branch: ${result.branch}`);
          if (result.pushed) {
            log.success('Pushed to origin. Open a PR or merge when you like.');
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
