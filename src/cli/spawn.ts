import fs from 'fs';
import path from 'path';
import * as readline from 'node:readline/promises';
import type { Command } from 'commander';
import type { ContainerRunner, RunOptions } from '../ports/runtime/index.js';
import { resolveRuntime, RUNTIME_NAMES } from '../ports/runtime/registry.js';
import {
  defaultWorktreesDir,
  worktreePathFor,
} from '../engine/runs/worktreesDir.js';
import { HostGit } from '../ports/git/host.js';
import type { Git } from '../ports/git/index.js';
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
import { readDotenvFile } from '../shared/utils/dotenv.js';
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
import {
  NOTHING_TO_RELEASE,
  prepareOneShotStack,
} from '../engine/spawn/oneShotStack.js';
import { executeSpawn } from '../engine/spawn/executeSpawn.js';
import { findRoot } from '../core/store/root.js';
import { runNamespace } from '../engine/runs/runNamespace.js';
import {
  eBaseDir,
  envFilePath,
  verifyCacheVolume,
} from '../core/store/paths.js';
import {
  isInitialized,
  readConfig,
  type LoopCaps,
} from '../core/store/config.js';
import { resolveOneShot } from '../engine/spawn/oneShot.js';
import {
  materializeBaseStore,
  oneShotStoreRoot,
  readQueuedConfig,
  type BaseStore,
} from '../engine/spawn/baseStore.js';
import { claimedBase, NO_LEDGER } from '../engine/queue/ledger.js';
import { localStack } from '../ports/runtime/stack.js';

import { log } from '../shared/utils/log.js';
import { env, Env } from '../shared/utils/env.js';
import { siblingSummaryLine } from '../engine/runs/runSiblings.js';
import { describeGateRemovals } from '../engine/runs/gateRemovals.js';
import { mergeLanded } from '../engine/runs/runMergeBack.js';
import {
  CANCEL_GRACE_MS,
  CANCELED_EXIT_CODE,
  type IterationOutcome,
  type RunBase,
  type RunSpawnResult,
} from '../engine/runs/runSpawn.js';

import { errorMessage } from '../shared/utils/errors.js';
import { readFusionMaterial } from '../core/fusion/material.js';
import {
  provenanceFromStrings,
  workflowEvent,
  type Provenance,
} from '../core/trigger/provenance.js';
import { newUlid } from '../engine/queue/runsSpool.js';
import { SPAWN_COMMAND, SPAWN_FLAGS } from '../shared/spawnArgs.js';
import { collectRepeatable } from './repeatable.js';

/** The parsed `e spawn` CLI options, as Commander hands them to the action. */
export interface SpawnCommandOptions extends Omit<RunOptions, 'envFile'> {
  runtime?: string;
  /**
   * `--rebuild` sets it, `--no-rebuild` clears it, the last one wins; neither
   * leaves it undefined, because Commander sets no default once both are
   * declared. Only an explicit `false` skips the rebuild.
   */
  rebuild?: boolean;
  dir?: string;
  /** Raw `--env-file <path>` value from the CLI (a single path). */
  envFile?: string;
  /** `--mcp <name>`, repeatable: MCP servers to wire for this run (container sidecars and/or remote URLs). */
  mcp?: string[];
  /** `--skill <name>`, repeatable: Skills to add for this run (comma-separated or repeated). */
  skill?: string[];
  /** `--keep-worktree`: leave the run's worktree in place after the container exits. */
  keepWorktree?: boolean;
  /** `--parent <branch>`: a manual child request - a human-written sibling of the live run `branch` (ADR-0013). */
  parent?: string;
  /** `--trigger <name>`: the one-shot shape - agent, prompt and base come from the trigger (ADR-0016 section 13). */
  trigger?: string;
  /** `--event <path>`: the payload file a `--trigger` run filters on and interpolates from. */
  event?: string;
  /** `--event-name <name>`: the provider's name for that payload; `$GITHUB_EVENT_NAME` when absent. */
  eventName?: string;
}

/**
 * What `--trigger` hands the ordinary spawn pipeline: the declaration's agent
 * and rendered prompt, plus what a typed `e spawn` never has - a declared
 * base, a payload to mount and the trigger's `loop` override.
 */
export interface TriggeredSpawn {
  agent: string;
  prompt: string;
  /** The run slug: `--name`, else the trigger's id. */
  name: string;
  base: RunBase;
  eventFile?: string;
  loop?: Partial<LoopCaps>;
  /** The Base Store the run reads its whole Store from, never the working tree's `.e/`. */
  store: BaseStore;
  /** `--env-file`, absolute: in one-shot it takes the place of `.e/.env`. */
  envFile?: string;
  /**
   * The trigger and the CI run that started it (ADR-0016 section 9): the
   * one-shot edge accepts the event the way the queue accepts a delivery.
   */
  provenance: Provenance;
}

/**
 * Walks the user through creating an OmniRoute endpoint key by hand, for when
 * the stack password will not issue one. This is the terminal half of the
 * handshake, which is why it lives here and not in the engine: `prepareLocalStack`
 * decides that a key is needed and stores the answer; this only asks for it.
 */
export async function promptForLocalApiKey({
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
  opts: SpawnCommandOptions,
  triggered?: TriggeredSpawn,
  git: Git = new HostGit()
): SpawnFacts {
  // A triggered run reads everything from its Base Store (ADR-0016 section 13).
  const root = triggered?.store.root ?? findRoot(opts.dir);
  // One-shot resolves its own base; a queued run's was resolved by `serve`,
  // and its repository's gate and caps are read from that base, never from
  // whatever the checkout has on disk (ADR-0016 section 5).
  const base = triggered?.base ?? claimedBase();
  // A fusion's candidate is a manual run cut from the base its fusion pinned
  // (ADR-0019): the checkout's config, not one read from that base.
  const fusionCandidate = env.fusionCandidate;
  const synthesis = env.fusionSynthesis;
  const fusionRun = fusionCandidate ?? synthesis;
  if (fusionRun && (triggered !== undefined || env.ledgerFile !== undefined)) {
    throw new Error(
      `A fusion ${fusionCandidate ? 'candidate' : 'synthesis'} of ${fusionRun.fusion} is started by its fusion, never by a trigger or the queue.`
    );
  }
  const fusionSynthesis = synthesis && {
    ...synthesis,
    summary: readFusionMaterial(synthesis.material),
  };
  const config =
    triggered === undefined && base !== undefined
      ? readQueuedConfig(git, root, base)
      : readConfig(root);
  // Sessions stay with the checkout's Store, never a Base Store's scratch
  // copy, which goes with the run (ADR-0017).
  const sessionRoot = triggered?.store.checkoutRoot ?? root;

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
  if (triggered && !isInitialized(harness.name, root)) {
    // `e init` on the runner cannot help: the Base Store is what is committed.
    throw new Error(
      `Harness "${harness.name}" is not in the Base Store: commit .e/harnesses/${harness.name}/Dockerfile (\`e init\`) at ${triggered.base.ref}.`
    );
  }

  // In one-shot `--env-file` takes the place of `.e/.env`: a provider's key
  // resolves from it, and it is filtered like `.e/.env` rather than copied
  // verbatim. No `.env` comes from any `.e/`, whose working tree is the
  // head's; a sibling of such a run carries the file by `E_STORE_ENV_FILE`.
  const storeEnvFile = triggered ? triggered.envFile : env.storeEnvFile;
  if (storeEnvFile !== undefined && !fs.existsSync(storeEnvFile)) {
    throw new Error(
      triggered
        ? `--env-file ${storeEnvFile} does not exist; in one-shot it is the only source of secrets.`
        : `${Env.STORE_ENV_FILE_VAR} names ${storeEnvFile}, which does not exist.`
    );
  }
  const baseEnvPath =
    storeEnvFile ?? (root !== undefined ? envFilePath(root) : undefined);
  const mcpNames = opts.mcp ?? [];
  // The shared `.e/.env` is the sole source of a provider's API key and any MCP
  // credential (ADR-0006) - read once, only when something needs it.
  const needStoreEnv = Boolean(agent.provider) || mcpNames.length > 0;
  const storeEnv = needStoreEnv ? readDotenvFile(baseEnvPath) : {};

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
    // happens later, in `prepareLocalStack`. A Base Store never has one.
    localStackPresent: localStack(root)?.present === true,
    // Every spawn rebuilds (ADR-0016 section 10): the pin catches a moved
    // version, not a changed Dockerfile, and a trigger has nobody to ask.
    rebuild: opts.rebuild !== false,
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
    // One-shot's `--env-file` is the base above, not a verbatim layer.
    userEnvFile: triggered ? undefined : opts.envFile,
    storeEnvFile,
    // A sibling of a one-shot run reads the Base Store too, never the head.
    dirOpt: triggered ? triggered.store.root : opts.dir,
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
    // The repository's gate (ADR-0016); the cache volume is named whether or
    // not the declaration opts in, because naming it costs nothing and the
    // check is the only thing that ever mounts it. It is named after the
    // checkout's Store, never the scratch copy, so the cache hits across runs.
    verify: config.verify,
    cacheVolume: verifyCacheVolume(triggered?.store.checkoutRoot ?? root),
    // A trigger may move `loop` field-wise, and nothing else (ADR-0016).
    loop: triggered?.loop ? { ...config.loop, ...triggered.loop } : config.loop,
    resources: config.resources,
    base: base ?? fusionRun?.base,
    fusionCandidate,
    fusionSynthesis,
    eventFile: triggered?.eventFile,
    provenance: triggered?.provenance ?? inheritedProvenance(),
    sessionStoreDir:
      sessionRoot !== undefined ? eBaseDir(sessionRoot) : undefined,
    // The run namespace is the sessions' Store's (#208): its runs are cut
    // in several repositories and keyed by run name alone.
    runNamespace: runNamespace(sessionRoot),
    // One-shot uses a running stack and never starts one (ADR-0016 section
    // 13), and so does a sibling its parent marked as one-shot.
    oneShotShape: triggered !== undefined || env.oneShotSibling,
  };
}

/**
 * The provenance a triggered run handed this `e spawn`: `e serve`'s queue to
 * a claimed request's run, a triggered parent to its sibling (ADR-0016
 * section 9). Read only where the host set the markers alongside the ones
 * that make this such a run, so a stale export in a human's shell never
 * makes a manual spawn look machine-started.
 */
export function inheritedProvenance(): Provenance | undefined {
  if (env.ledgerFile === undefined && env.sibling === undefined) {
    return undefined;
  }
  const vars = env.provenance;
  return vars ? provenanceFromStrings(vars) : undefined;
}

/**
 * `--trigger <name> [--event <path>]` (ADR-0016 section 13): the declaration,
 * read from base, turned into the arguments of an ordinary spawn - or into
 * the reason no run starts, which is not an error. Refuses what the
 * declaration already decides: an agent or a prompt on the command line.
 * A run to start gets its Base Store, materialized into `scratch`, which
 * disposes of it with the run. Exported for its tests.
 */
export function resolveTriggerSpawn(
  target: string | undefined,
  prompt: string[],
  opts: SpawnCommandOptions,
  deps: { git: Git; scratch: RunScratch },
  now: Date = new Date()
): TriggeredSpawn | { skip: string } {
  const { git, scratch } = deps;
  const name = opts.trigger!;
  if (target !== undefined || prompt.length > 0) {
    throw new Error(
      `--trigger ${name} takes its agent and prompt from the declaration; drop the positional arguments`
    );
  }
  if (opts.parent !== undefined) {
    throw new Error('--trigger and --parent cannot be combined');
  }
  // `--dir`, else the toplevel: never the upward walk, which a nested `.e/`
  // in the head could steer.
  const root = oneShotStoreRoot(git, opts.dir);
  const resolved = resolveOneShot(git, {
    name,
    root,
    // Inside the repository by construction. The agent names are not
    // checked here: the working tree's are the head's, and an unknown agent
    // fails in `findAgent`, against the Base Store.
    context: { repoLocal: true },
    eventPath: opts.event !== undefined ? path.resolve(opts.event) : undefined,
    eventName: opts.eventName ?? env.githubEventName,
    now,
  });
  if (resolved.kind === 'skip') return { skip: resolved.reason };
  for (const warning of resolved.warnings) log.warn(warning);
  const materialized = materializeBaseStore(git, {
    checkoutRoot: root,
    base: resolved.base,
    dest: scratch.dir(),
  });
  for (const warning of materialized.warnings) log.warn(warning);
  for (const notice of materialized.notices) log.info(notice);
  return {
    agent: resolved.trigger.agent,
    prompt: resolved.prompt,
    name: opts.name ?? resolved.trigger.name,
    base: resolved.base,
    ...(resolved.eventFile !== undefined
      ? { eventFile: resolved.eventFile }
      : {}),
    ...(resolved.trigger.loop ? { loop: resolved.trigger.loop } : {}),
    store: materialized.store,
    provenance: {
      trigger: resolved.trigger.name,
      ...workflowEvent(env.githubWorkflowRun, newUlid()),
    },
    ...(opts.envFile !== undefined
      ? { envFile: path.resolve(opts.envFile) }
      : {}),
  };
}

/**
 * The remote-agent short circuit (ADR-0015): when the spawn target names a
 * Store agent with `transport: "a2a"`, there is nothing to build or run -
 * the prompt goes over A2A. Returns what `runRemoteAgent` needs, or undefined
 * for an ordinary (harness) target. `root` is the Store the agent is looked
 * up in: a triggered run's Base Store, else the one `--dir` finds. Exported
 * for its tests.
 */
export function resolveRemoteTarget(
  target: string | undefined,
  prompt: string[],
  opts: SpawnCommandOptions,
  root: string | undefined = findRoot(opts.dir)
):
  | { agent: RemoteA2aAgent; prompt: string; storeEnv: Record<string, string> }
  | undefined {
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
    storeEnv: readDotenvFile(baseEnvPath),
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
/** One attempt of a gated run, as the human reads it. */
function iterationSummaryLine(iteration: IterationOutcome): string {
  const head = `Attempt ${iteration.attempt}: `;
  if (iteration.verdict === undefined) {
    // No verdict means the attempt never reached the check.
    return `${head}the harness exited ${iteration.harnessExitCode}, nothing committed.`;
  }
  if (iteration.verdict === 'green') return `${head}verify green.`;
  if (iteration.verdict === 'broken') {
    return `${head}the check could not run (exited ${iteration.verifyExitCode}).`;
  }
  return `${head}verify red (exited ${iteration.verifyExitCode}).`;
}

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
  // The loop, one line per attempt, then how it ended - stated, never derived
  // from the last entry (ADR-0016). Bounded by the iteration cap, so it cannot
  // run away.
  for (const iteration of result.iterations ?? []) {
    lines.push({
      level: iteration.verdict === 'green' ? 'success' : 'info',
      text: iterationSummaryLine(iteration),
    });
  }
  if (result.softTimeoutWarning) {
    lines.push({ level: 'warn', text: result.softTimeoutWarning });
  }
  if (result.outcome) {
    const attempts = result.iterations?.length ?? 0;
    const plural = attempts === 1 ? 'attempt' : 'attempts';
    // The reason is carried rather than inferred: an OOM and our own kill both
    // end the container on 137, so "exhausted" alone would not say which.
    const why = result.reason ? ` (${result.reason})` : '';
    // Gate removals qualify the one word they cast doubt on, and only it:
    // no other outcome makes a claim to qualify (ADR-0016 section 11).
    const weakened =
      result.gateRemovals && result.gateRemovals.files > 0
        ? ` (gate weakened: ${describeGateRemovals(result.gateRemovals)})`
        : '';
    lines.push(
      result.outcome === 'verified'
        ? {
            level: weakened ? 'warn' : 'success',
            text: `Verified after ${attempts} ${plural}${weakened}.`,
          }
        : {
            level: 'warn',
            text:
              result.outcome === 'exhausted'
                ? `Exhausted after ${attempts} ${plural}${why}.`
                : `Aborted after ${attempts} ${plural}${why}.`,
          }
    );
  }
  // The numbers themselves, whatever the outcome: recorded, not a verdict.
  if (result.gateRemovals) {
    lines.push({
      level: 'info',
      text: `Gate removals (lines deleted under verify.guards over the branch): ${describeGateRemovals(result.gateRemovals)}.`,
    });
  }
  // Siblings this run requested and how their work came back (ticket 07).
  for (const sibling of result.siblings ?? []) {
    lines.push({
      level: mergeLanded(sibling.merge) ? 'info' : 'warn',
      text: siblingSummaryLine(sibling),
    });
  }
  // Where a sibling's unmerged work went, since it is not in this branch.
  for (const branch of result.siblingBranchesPushed ?? []) {
    lines.push({ level: 'info', text: `Pushed unmerged sibling ${branch}.` });
  }
  for (const warning of result.siblingPushWarnings ?? []) {
    lines.push({ level: 'warn', text: `Warning: ${warning}` });
  }
  if (result.mergeWarning) {
    lines.push({ level: 'warn', text: `Warning: ${result.mergeWarning}` });
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

/** What {@link spawnCancelHandling} needs from the process; a test fakes all of it. */
export interface SpawnCancelDeps {
  /** Aborted by the first signal; the run tears down on it. */
  cancel: AbortController;
  warn(text: string): void;
  /** Starts the grace timer (unref'd in production, so it never holds the run open). */
  setTimer(fn: () => void, ms: number): void;
  /** Drops the rendered secret files. */
  dispose(): void;
  exit(code: number): void;
}

/**
 * The signal handler of `e spawn` (ADR-0015). The first SIGINT or SIGTERM
 * cancels: the container is stopped and the run tears down - worktree,
 * sidecars, network, rendered secret files - pushing nothing. Every later
 * one is acknowledged and waited out, never taken as leave to exit: a Ctrl-C
 * had no handler at all, so it killed `e` wherever it was and left the
 * worktree and the secret files behind - and a second Ctrl-C to leave a
 * harness TUI (Codex quits on the first) reached `e` while it captured the
 * run. Only when the grace is spent does `e` exit, and it still drops the
 * secret files first.
 */
export function spawnCancelHandling(deps: SpawnCancelDeps): () => void {
  return () => {
    if (deps.cancel.signal.aborted) {
      deps.warn('Still canceling: waiting for the run to tear down.');
      return;
    }
    deps.warn('Canceling the run: stopping its container and tearing down...');
    deps.cancel.abort();
    deps.setTimer(() => {
      deps.dispose();
      deps.exit(CANCELED_EXIT_CODE);
    }, CANCEL_GRACE_MS);
  };
}

/** What a spawn needs from the process it runs in; the action supplies both. */
export interface SpawnCommandDeps {
  /** Owns every rendered secret file this run writes; one dispose() cleans up. */
  scratch: RunScratch;
  /** A cancel (SIGTERM, or an A2A client's cancelTask), forwarded to the run. */
  abort?: AbortSignal;
  /** The host's git; a test passes a fake. */
  git?: Git;
  /** The container runtime; a test passes a fake, else `--runtime` resolves it. */
  runtime?: ContainerRunner;
  /** Override the global `fetch` for OmniRoute's key API, so a test can script it. */
  fetchImpl?: typeof fetch;
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
  const git = deps.git ?? new HostGit();
  try {
    if (opts.event !== undefined && opts.trigger === undefined) {
      throw new Error(
        '--event needs --trigger: a payload is only read for a trigger'
      );
    }
    // The one-shot shape (ADR-0016 section 13): the declaration supplies the
    // agent and the prompt. A non-match is no run, so it exits 0 - the exit
    // codes describe a run's verdict, and here no run existed.
    let triggered: TriggeredSpawn | undefined;
    if (opts.trigger !== undefined) {
      const out = resolveTriggerSpawn(target, prompt, opts, { git, scratch });
      if ('skip' in out) {
        log.info(out.skip);
        return 0;
      }
      triggered = out;
      target = out.agent;
      prompt = [out.prompt];
      opts = { ...opts, name: out.name };
    }

    // A remote A2A agent (ADR-0015) is answered over the wire: no image, no
    // worktree, the answer on stdout.
    const remote = resolveRemoteTarget(
      target,
      prompt,
      opts,
      triggered?.store.root ?? findRoot(opts.dir)
    );
    if (remote && triggered) {
      // A remote agent has no worktree to cut from base and nowhere to mount
      // the payload; running it anyway would drop both without a word.
      throw new Error(
        `--trigger ${opts.trigger} names "${remote.agent.name}", a remote A2A agent: one-shot needs a harness agent, which has a base and a payload mount`
      );
    }
    if (remote) return await runRemoteAgent({ ...remote, abort });

    const gathered = gatherSpawnFacts(target, prompt, opts, triggered, git);
    validateSpawn(gathered);
    const runtime = deps.runtime ?? resolveRuntime(opts.runtime);
    // One-shot uses a stack that is already running and mints the run's own
    // key, which `release` deletes after teardown; a manual run brings its
    // Store's stack up and keeps its key in `.e/.env`.
    const prepared = gathered.oneShotShape
      ? await prepareOneShotStack(gathered, {
          runtime,
          fetchImpl: deps.fetchImpl,
        })
      : {
          facts: await prepareLocalStack(gathered, {
            runtime,
            askForKey: promptForLocalApiKey,
          }),
          release: NOTHING_TO_RELEASE,
        };
    const { facts } = prepared;

    let result;
    try {
      result = await executeSpawn(facts, planSpawn(facts), {
        git,
        runtime,
        scratch,
        pullRequest: facts.gitPlatform ? new HostPullRequest() : undefined,
        gitPlatform: facts.gitPlatform,
        abort,
        // The ledger is `serve`'s; in one-shot the outer scheduler owns what
        // it describes (ADR-0016 section 13).
        ...(triggered ? { ledger: NO_LEDGER } : {}),
      });
    } finally {
      // After teardown, on every way out: a red run, an abort, a throw.
      await prepared.release();
    }

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
      `${SPAWN_FLAGS.mcp} <name>`,
      'MCP server to wire for this run - container (sidecar) or remote (hosted URL); repeatable',
      collectRepeatable
    )
    .option(
      `${SPAWN_FLAGS.skill} <name>`,
      'Skill(s) to add for this run, from .e/skills (comma-separated or repeated)',
      collectRepeatable
    )
    .option(
      SPAWN_FLAGS.rebuild,
      'build every image the run needs (the default; kept so old command lines parse)'
    )
    .option(
      SPAWN_FLAGS.noRebuild,
      'build only the images that are missing or off the version pin'
    )
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
      '--trigger <name>',
      'one-shot: run the trigger .e/triggers/<name>, read from its base (agent and prompt come from it)'
    )
    .option(
      '--event <path>',
      'with --trigger: the event payload to filter on and interpolate from, e.g. "$GITHUB_EVENT_PATH"'
    )
    .option(
      '--event-name <name>',
      "with --event: the provider's event name (default: $GITHUB_EVENT_NAME)"
    )
    .option(
      '-p, --port <port>',
      'publish a container port, e.g. 8080:80 (repeatable)',
      collectRepeatable
    )
    .option(
      '-e, --env <env>',
      'set an environment variable, e.g. KEY=value (repeatable)',
      collectRepeatable
    )
    .action(
      async (
        target: string | undefined,
        prompt: string[],
        opts: SpawnCommandOptions
      ) => {
        const scratch = new RunScratch();
        // SIGTERM and SIGINT are a cancel (ADR-0015): a sibling its parent
        // canceled or gave up on, an A2A task its client canceled, a one-shot
        // run's scheduler, a human's Ctrl-C. The run stops its container and
        // tears down as usual (`RunSpawnParams.abort`).
        const cancel = new AbortController();
        const onCancel = spawnCancelHandling({
          cancel,
          warn: text => log.warn(text),
          setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
          dispose: () => scratch.dispose(),
          exit: code => process.exit(code),
        });
        process.on('SIGTERM', onCancel);
        process.on('SIGINT', onCancel);
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
