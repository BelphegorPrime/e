import fs from 'fs';
import * as readline from 'node:readline/promises';
import type { Command } from 'commander';
import type { RunOptions } from '../ports/runtime/index.js';
import { resolveRuntime, RUNTIME_NAMES } from '../ports/runtime/registry.js';
import {
  defaultWorktreesDir,
  worktreePathFor,
} from '../engine/runs/worktreesDir.js';
import { HostGit } from '../ports/git/host.js';
import { HostPullRequest } from '../ports/github/host.js';
import { fromBranch } from '../core/identity/runName.js';
import { brokerSpoolDirFor } from '../engine/runs/runBroker.js';
import {
  nextRequestId,
  ensureSpool,
  readRunInfo,
  writeRequest,
} from '../sidecars/broker/contract/spool.js';
import {
  resolveSpawnTarget,
  validateSpawn,
  planSpawn,
  type SpawnFacts,
} from '../engine/spawn/spawnPlan.js';
import { resolveHarness, HARNESSES } from '../core/harness/index.js';
import {
  findAgent,
  isKnownTarget,
  isRemoteAgent,
  type RemoteA2aAgent,
} from '../core/agent/index.js';
import { runRemoteAgent } from '../engine/a2a/remoteSpawn.js';
import { parseDotenv } from '../shared/utils/dotenv.js';
import {
  ensureShippedSkill,
  resolveSkill,
  parseSkillList,
} from '../core/skill/index.js';
import {
  readMcpServer,
  listMcpServerNames,
  type McpServer,
} from '../core/mcp/index.js';
import { RunScratch } from '../engine/runs/runScratch.js';
import {
  prepareLocalStack,
  type ApiKeyRequest,
} from '../engine/spawn/prepareLocalStack.js';
import { executeSpawn } from '../engine/spawn/executeSpawn.js';
import { findRoot } from '../core/store/root.js';
import { envFilePath } from '../core/store/paths.js';
import { readConfig } from '../core/store/config.js';
import { localStack } from '../ports/runtime/stack.js';

import { log } from '../shared/utils/log.js';
import { env } from '../shared/utils/env.js';
import { siblingSummaryLine } from '../engine/runs/runSiblings.js';
import { mergeLanded } from '../engine/runs/runMergeBack.js';
import {
  CANCELED_EXIT_CODE,
  type RunSpawnResult,
} from '../engine/runs/runSpawn.js';

import { errorMessage } from '../shared/utils/errors.js';
import { SPAWN_COMMAND, SPAWN_FLAGS } from '../shared/spawnArgs.js';
/** How long a canceled `e spawn` may take to stop its container and tear down before it is exited by force. */
const CANCEL_GRACE_MS = 60_000;

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
  /** `--keep-worktree`: leave the run's worktree in place after the container exits. */
  keepWorktree?: boolean;
  /** `--parent <branch>`: a manual child request - a human-written sibling of the live run `branch` (ADR-0013). */
  parent?: string;
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
 * Walks the user through creating an OmniRoute endpoint key by hand, for when
 * the stack password will not issue one. This is the terminal half of the
 * handshake, which is why it lives here and not in the engine: `prepareLocalStack`
 * decides that a key is needed and stores the answer; this only asks for it.
 */
async function promptForLocalApiKey({
  initialPassword,
}: ApiKeyRequest): Promise<string> {
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
      if (key) return key;
      log.warn('API key cannot be blank.');
    }
  } finally {
    rl.close();
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
 * complete {@link SpawnFacts} value - the one step that reads, before the pure
 * pipeline ({@link validateSpawn} → {@link planSpawn} → executeSpawn). It
 * resolves the Agent, the Harness, the store config and env, and every requested
 * MCP server and skill *now* (existence checked, throwing a clear error), so a
 * bad name fails fast - before any build or a worktree. `config.json` is read
 * once here and nothing downstream reads it again.
 *
 * Exported for its tests; the action is its only production caller.
 */
export function gatherSpawnFacts(
  target: string | undefined,
  prompt: string[],
  opts: SpawnCommandOptions
): SpawnFacts {
  const root = findRoot(opts.dir);
  const config = readConfig(root);

  // The target is an agent/harness name resolved directly (a bare harness →
  // its default agent).
  const resolved = resolveSpawnTarget({
    target,
    prompt,
    defaultHarness: config.defaultHarness,
    isKnownTarget: name => isKnownTarget(name, root),
  });
  const agent = findAgent(resolved.agentTarget, root);
  if (isRemoteAgent(agent)) {
    // The action answers a remote agent before gathering facts (see
    // `resolveRemoteTarget`); reaching this means a caller skipped that step.
    throw new Error(
      `Agent "${agent.name}" is a remote A2A agent and has no harness to spawn.`
    );
  }
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

  return {
    root,
    agent,
    harness,
    storeEnv,
    mcpServers,
    perRunSkills,
    bakedSkills,
    prompt: resolved.prompt.join(' '),
    // Whether the store has a local OmniRoute stack is a plain file check, so
    // it is a gathered fact like any other; bringing it *up* is an effect and
    // happens later, in `prepareLocalStack`.
    localStackPresent: localStack(root)?.present === true,
    rebuild: Boolean(opts.rebuild),
    name: opts.name,
    env: opts.env ?? [],
    port: opts.port,
    // The mode follows the prompt (isInteractiveRun); a TUI needs one of these.
    stdinIsTty: env.stdinIsTty,
    headlessTty: env.headlessTty,
    rm: opts.rm,
    keepWorktree: Boolean(opts.keepWorktree),
    // Layer the shared base only when it exists on disk (ADR-0006).
    baseEnvFile:
      baseEnvPath !== undefined && fs.existsSync(baseEnvPath)
        ? baseEnvPath
        : undefined,
    userEnvFile: opts.envFile,
    dirOpt: opts.dir,
    // Platform default or `E_WORKTREES_DIR`; a path the engine can bind-mount.
    worktreesDir: defaultWorktreesDir(),
    // `parent` unless the `E_SPAWN_ROLE` marker says `child` (ADR-0013).
    role: env.spawnRole,
    // Set by a parent run's host for a sibling request (ADR-0013).
    sibling: env.sibling,
    // Set by the A2A facade of `e serve` for a run it watches (ADR-0015).
    report: env.report,
    // The store's settings, read once with the rest of config.json.
    siblingArtifacts: config.siblingArtifacts,
    maxSiblings: config.maxSiblings,
    localRuntimes: config.localRuntimes,
    gitPlatform: config.gitPlatform,
  };
}

/**
 * The remote-agent short circuit (ADR-0015): when the spawn target names a
 * Store agent with `transport: "a2a"`, there is nothing to build or run -
 * the prompt goes over A2A. Returns what `runRemoteAgent` needs, or undefined
 * for an ordinary (harness) target. Exported for its tests.
 */
export function resolveRemoteTarget(
  target: string | undefined,
  prompt: string[],
  opts: SpawnCommandOptions
):
  | { agent: RemoteA2aAgent; prompt: string; storeEnv: Record<string, string> }
  | undefined {
  const root = findRoot(opts.dir);
  const resolved = resolveSpawnTarget({
    target,
    prompt,
    defaultHarness: readConfig(root).defaultHarness,
    isKnownTarget: name => isKnownTarget(name, root),
  });
  const agent = findAgent(resolved.agentTarget, root);
  if (!isRemoteAgent(agent)) return undefined;
  const baseEnvPath = root !== undefined ? envFilePath(root) : undefined;
  return {
    agent,
    prompt: resolved.prompt.join(' '),
    storeEnv: loadStoreEnv(baseEnvPath),
  };
}

/**
 * The manual child request behind `--parent <branch>` (ADR-0013): a human
 * writes the request into the named run's broker spool exactly as the broker
 * would (`POST /spawn`), and the run's own `SiblingConsumer` picks it up as
 * any other sibling - same checkpoint, artifact sync, fan-out cap, merge-back
 * and report. Nothing here launches a container; the request is the whole
 * manual surface.
 *
 * Depth stays two: a run already wearing the sibling markers (itself a
 * child) refuses, and the parent's spool must belong to a `parent` role run
 * (a child has no broker of its own). The parent run must be live: its
 * broker spool exists only while it runs.
 */
export function manualSiblingRequest(
  target: string | undefined,
  prompt: string[],
  opts: SpawnCommandOptions,
  worktreesDirOverride?: string
): { id: string; status: 'requested'; statusPath: string } {
  const parentBranch = opts.parent!.trim();
  // A sibling is already at depth two; a manual child under it would be the
  // grandchildren ADR-0013 forbids. Only the host may go deeper than that.
  if (env.sibling) {
    throw new Error(
      `A sibling run cannot start a manual child (--parent ${parentBranch}): depth is capped at two (ADR-0013).`
    );
  }
  const run = fromBranch(parentBranch);
  if (!run) {
    throw new Error(
      `--parent must name a run branch (e/<agent>/<slug>-N), got "${parentBranch}".`
    );
  }
  const worktreesDir = worktreesDirOverride ?? defaultWorktreesDir();
  const parentWorktree = worktreePathFor(worktreesDir, run);
  if (!fs.existsSync(parentWorktree)) {
    throw new Error(
      `--parent names run ${run.name}, but this host has no live worktree for it (${parentWorktree}).`
    );
  }
  const spool = brokerSpoolDirFor(worktreesDir, run);
  const info = readRunInfo(spool);
  if (!info) {
    throw new Error(
      `Run ${run.name} has no runtime-broker, so it cannot take children: start it with --skill spawn-brother (ADR-0013).`
    );
  }
  if (info.role === 'child') {
    throw new Error(
      `Cannot make ${run.name} a parent: it is itself a child (depth is capped at two, ADR-0013).`
    );
  }
  const root = findRoot(opts.dir);
  const resolved = resolveSpawnTarget({
    target,
    prompt,
    defaultHarness: readConfig(root).defaultHarness,
    isKnownTarget: name => isKnownTarget(name, root),
  });
  if (resolved.prompt.join(' ').trim() === '') {
    throw new Error(
      'A manual child needs a prompt; pass one after the agent name.'
    );
  }
  const id = nextRequestId(spool);
  ensureSpool(spool);
  writeRequest(spool, {
    id,
    agent: resolved.agentTarget,
    prompt: resolved.prompt.join(' '),
    requestedAt: new Date().toISOString(),
  });
  return { id, status: 'requested', statusPath: `/status/${id}` };
}

/** One line of a finished run's closing report: what to say and how to say it. */
export interface ReportLine {
  level: 'info' | 'warn' | 'success' | 'error';
  text: string;
}

/**
 * Turns a finished run into the lines to print, in order. Pure, so what a run
 * tells the user is asserted directly instead of by capturing stdout - the
 * whole tail of the spawn action used to be unreachable from a test.
 */
export function spawnReport(result: RunSpawnResult): ReportLine[] {
  if (result.error) return [{ level: 'error', text: result.error }];
  const lines: ReportLine[] = [];
  if (result.pushWarning) {
    lines.push({ level: 'warn', text: `Warning: ${result.pushWarning}` });
  }
  if (result.pushed) {
    lines.push({
      level: 'success',
      text: 'Pushed to origin. Open a PR or merge when you like.',
    });
  }
  if (result.pullRequestUrl) {
    lines.push({
      level: 'success',
      text: `Pull request: ${result.pullRequestUrl}`,
    });
  }
  // Siblings this run requested and how their work came back (ticket 07).
  for (const sibling of result.siblings ?? []) {
    lines.push({
      level: mergeLanded(sibling.merge) ? 'info' : 'warn',
      text: siblingSummaryLine(sibling),
    });
  }
  if (result.pullRequestWarning) {
    lines.push({
      level: 'warn',
      text: `Warning: ${result.pullRequestWarning}`,
    });
  }
  lines.push({ level: 'success', text: `\nRun branch: ${result.branch}` });
  if (result.captured) {
    lines.push({
      level: 'success',
      text: 'Captured uncommitted changes in a host commit.',
    });
  }
  return lines;
}

/** What a spawn needs from the process it runs in; the action supplies both. */
export interface SpawnCommandDeps {
  /** Owns every rendered secret file this run writes; one dispose() cleans up. */
  scratch: RunScratch;
  /** A cancel (SIGTERM, or an A2A client's cancelTask), forwarded to the run. */
  abort?: AbortSignal;
}

/**
 * The whole `e spawn`: gather facts (the reads) → validate (pure, fail-fast) →
 * prepare the local stack (the one effect in the middle) → plan (pure) →
 * execute. Returns the exit code rather than taking it; `process.exit` and the
 * signal handling stay in the Commander action, so everything that decides what
 * a run does - and what it reports - can be called from a test (ADR-0008).
 */
export async function runSpawnCommand(
  target: string | undefined,
  prompt: string[],
  opts: SpawnCommandOptions,
  deps: SpawnCommandDeps
): Promise<number> {
  const { scratch, abort } = deps;
  try {
    // A remote A2A agent (ADR-0015) is answered over the wire: no image, no
    // worktree, the answer on stdout.
    const remote = resolveRemoteTarget(target, prompt, opts);
    if (remote) return await runRemoteAgent({ ...remote, abort });

    const gathered = gatherSpawnFacts(target, prompt, opts);
    validateSpawn(gathered);
    const runtime = resolveRuntime(opts.runtime);
    const facts = await prepareLocalStack(gathered, {
      runtime,
      askForKey: promptForLocalApiKey,
    });

    const result = await executeSpawn(facts, planSpawn(facts), {
      git: new HostGit(),
      runtime,
      scratch,
      pullRequest: facts.gitPlatform ? new HostPullRequest() : undefined,
      gitPlatform: facts.gitPlatform,
      abort,
    });

    // Rendered env-files hold resolved secrets; each container already has its
    // own copy, so drop them before reporting and exiting. This is independent
    // of --keep-worktree, which only concerns the worktree.
    scratch.dispose();
    for (const line of spawnReport(result)) log[line.level](line.text);
    return result.exitCode;
  } catch (err) {
    log.error(errorMessage(err));
    return 1;
  } finally {
    // Idempotent, so the early dispose above still gets the secrets out before
    // anything is printed; this is the net under every other way out - a throw,
    // and the remote-agent return that never reaches the line above.
    scratch.dispose();
  }
}

export function registerSpawnCommand(program: Command): void {
  program
    .command(SPAWN_COMMAND)
    .description('Build and run a coding harness in a container')
    .argument(
      '[target]',
      `agent or harness to run (harnesses: ${Object.keys(HARNESSES).join(', ')})`
    )
    .argument('[prompt...]', 'instruction passed to the harness')
    .option(
      `${SPAWN_FLAGS.runtime} <runtime>`,
      `container runtime to use: ${RUNTIME_NAMES.join(', ')} (default: $E_RUNTIME, else the first one on PATH)`
    )
    // The flags anything re-invoking this CLI has to spell are declared from
    // `SPAWN_FLAGS`, so a rename cannot land here without breaking every
    // caller that builds an `e spawn` command line (`shared/spawnArgs.ts`).
    .option(
      `${SPAWN_FLAGS.name} <name>`,
      'name for the run (overrides the prompt-derived slug)'
    )
    .option(
      `${SPAWN_FLAGS.envFile} <path>`,
      'load environment variables from a file'
    )
    .option(
      `${SPAWN_FLAGS.mcp} <name...>`,
      'MCP server(s) to wire for this run - container (sidecar) or remote (hosted URL); repeatable'
    )
    .option(
      `${SPAWN_FLAGS.skill} <name...>`,
      'Skill(s) to add for this run, from .e/skills (comma-separated or repeated)'
    )
    .option(SPAWN_FLAGS.rebuild, 'force a rebuild of the harness image', false)
    .option(
      `${SPAWN_FLAGS.dir} <path>`,
      'root directory holding the harness Dockerfiles (default: home directory)'
    )
    .option('--rm', 'automatically remove the container when it exits', true)
    .option('--no-rm', 'keep the container after it exits')
    .option(SPAWN_FLAGS.keepWorktree, 'keep the worktree after container exits')
    .option(
      `${SPAWN_FLAGS.parent} <branch>`,
      'manual child request: add a sibling to the live run `branch` (ADR-0013), then exit'
    )
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
        const scratch = new RunScratch();
        // SIGTERM is a cancel (ADR-0015): a sibling its parent canceled or
        // gave up on, an A2A task its client canceled. The run stops its
        // container and tears down as usual (`RunSpawnParams.abort`); should
        // that hang, the fallback below still drops the rendered secret files
        // and exits (Node's default would exit without any cleanup).
        const cancel = new AbortController();
        process.once('SIGTERM', () => {
          cancel.abort();
          setTimeout(() => {
            scratch.dispose();
            process.exit(CANCELED_EXIT_CODE);
          }, CANCEL_GRACE_MS).unref();
        });
        // A manual child request never runs a container: it writes one
        // sibling request into the parent run's broker spool and exits, the
        // host equivalent of the broker's `POST /spawn` (ADR-0013).
        if (opts.parent !== undefined) {
          try {
            const accepted = manualSiblingRequest(target, prompt, opts);
            log.info(JSON.stringify(accepted));
            process.exit(0);
          } catch (err) {
            log.error(errorMessage(err));
            process.exit(1);
          }
        }
        process.exit(
          await runSpawnCommand(target, prompt, opts, {
            scratch,
            abort: cancel.signal,
          })
        );
      }
    );
}
