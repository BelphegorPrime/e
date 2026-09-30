import fs from 'node:fs';
import type { Command } from 'commander';
import type { ContainerRunner } from '../ports/runtime/index.js';
import { resolveRuntime, RUNTIME_NAMES } from '../ports/runtime/registry.js';
import { HostGit } from '../ports/git/host.js';
import type { Git } from '../ports/git/index.js';
import { HostPullRequest } from '../ports/github/host.js';
import { fromBranch, type RunName } from '../core/identity/runName.js';
import {
  harnessCapabilities,
  resolveHarness,
  resumableHarnessNames,
} from '../core/harness/index.js';
import { findAgent, isRemoteAgent } from '../core/agent/index.js';
import { findRoot } from '../core/store/root.js';
import { eBaseDir } from '../core/store/paths.js';
import { readConfig } from '../core/store/config.js';
import { defaultWorktreesDir } from '../engine/runs/worktreesDir.js';
import { brokerSpoolDirFor } from '../engine/runs/runBroker.js';
import {
  SESSION_RETENTION_DAYS,
  hasSessionTranscript,
  readRunSession,
  sessionProvider,
  type RunSessionRecord,
} from '../engine/runs/runSession.js';
import type { TaskState } from '../sidecars/broker/contract/types.js';
import { RunScratch } from '../engine/runs/runScratch.js';
import {
  planSpawn,
  validateSpawn,
  type SpawnFacts,
} from '../engine/spawn/spawnPlan.js';
import { prepareLocalStack } from '../engine/spawn/prepareLocalStack.js';
import { executeSpawn } from '../engine/spawn/executeSpawn.js';
import { listRecords } from '../sidecars/broker/contract/spool.js';
import { SPAWN_FLAGS } from '../shared/spawnArgs.js';
import { env } from '../shared/utils/env.js';
import { log } from '../shared/utils/log.js';
import { errorMessage } from '../shared/utils/errors.js';
import { collectRepeatable } from './repeatable.js';
import {
  gatherSpawnFacts,
  promptForLocalApiKey,
  spawnCancelHandling,
  spawnReport,
  type SpawnCommandOptions,
} from './spawn.js';

/**
 * **`e resume <run-branch> ["follow-up prompt"]`** (ADR-0017): continue the
 * harness session of an earlier Run on its own branch, in a fresh container,
 * with the agent, MCP servers and per-run skills it was started with. Every
 * refusal ADR-0017 names happens in {@link resolveResume}, before any image,
 * worktree or container; then it is the ordinary spawn pipeline with the
 * `resume` fact set.
 */

/** The parsed `e resume` options: the subset of `e spawn`'s a resume takes. */
export type ResumeCommandOptions = Pick<
  SpawnCommandOptions,
  'runtime' | 'dir' | 'envFile' | 'keepWorktree' | 'rebuild' | 'env'
>;

/** What a resume continues, once every refusal is behind it. */
export interface ResumeTarget {
  run: RunName;
  record: RunSessionRecord;
  /** Drift that does not stop the resume: a new harness version, a new provider. */
  warnings: string[];
}

/** A sibling's task states that still wait on its parent's run. */
const IN_FLIGHT: ReadonlySet<TaskState> = new Set<TaskState>([
  'submitted',
  'working',
  'input-required',
]);

/**
 * The preflight of a resume: fails fast, with the reason, on a branch that is
 * not a run branch, a harness that cannot resume, a branch that is gone, a
 * missing session, a session another harness wrote, a spent wall clock, a
 * Run that is still running, and siblings still in flight. Reads only.
 * Exported for its tests.
 */
export function resolveResume(
  branchArg: string,
  opts: Pick<ResumeCommandOptions, 'dir'>,
  deps: {
    git: Git;
    runtime: Pick<ContainerRunner, 'isRunning'>;
    worktreesDir: string;
    /** No follow-up prompt: the TUI, which has no wall-clock budget. */
    interactive: boolean;
  }
): ResumeTarget {
  // Only the host resumes: a sibling that could would be a third level.
  if (env.sibling) {
    throw new Error(
      'A sibling run cannot resume a run: depth is capped at two (ADR-0013).'
    );
  }
  const run = fromBranch(branchArg.trim());
  if (!run) {
    throw new Error(
      `"${branchArg}" is not a run branch (e/<agent>/<slug>-N); e resume continues a Run by its branch.`
    );
  }
  const root = findRoot(opts.dir);
  const agent = findAgent(run.agent, root);
  if (isRemoteAgent(agent)) {
    throw new Error(
      `Agent "${agent.name}" is a remote A2A agent: it has no session e keeps.`
    );
  }
  const harness = resolveHarness(agent.harness);
  if (!harnessCapabilities(harness).resume) {
    throw new Error(
      `Harness "${harness.name}" cannot resume a session: it declares no resumeCommand. e resume supports: ${resumableHarnessNames().join(', ')}.`
    );
  }

  const { git } = deps;
  const exists =
    git.resolveCommit(`refs/heads/${run.branch}`) !== undefined ||
    git.resolveCommit(`refs/remotes/origin/${run.branch}`) !== undefined ||
    git
      .listRunBranches(`e/${run.agent}/${run.slug}`)
      .some(name => name === run.branch || name === `origin/${run.branch}`);
  if (!exists) {
    throw new Error(
      `Cannot resume: there is no branch ${run.branch} here or on origin.`
    );
  }

  const storeDir = root !== undefined ? eBaseDir(root) : undefined;
  const record = storeDir ? readRunSession(storeDir, run) : undefined;
  if (!storeDir || !record || !hasSessionTranscript(storeDir, run)) {
    throw new Error(
      `${run.branch} has no stored session in this Store: sessions are kept for ${SESSION_RETENTION_DAYS} days after their last use, for runs of ${resumableHarnessNames().join(', ')} (ADR-0017).`
    );
  }

  // Drift (ADR-0017): a transcript is its harness's own format, so another
  // harness cannot read it; a new version or provider can.
  if (record.harness !== harness.name) {
    throw new Error(
      `The session of ${run.branch} was written by harness "${record.harness}", but agent "${agent.name}" now runs "${harness.name}": it cannot read it.`
    );
  }
  const warnings: string[] = [];
  if (record.harnessVersion !== harness.version) {
    warnings.push(
      `The session of ${run.branch} was written by ${harness.name} ${record.harnessVersion}; it is ${harness.version} now.`
    );
  }
  const currentProvider = sessionProvider(agent.provider);
  if (JSON.stringify(currentProvider) !== JSON.stringify(record.provider)) {
    warnings.push(
      `The provider changed since ${run.branch} last ran (${describeProvider(record.provider)} -> ${describeProvider(currentProvider)}); resuming on the new one.`
    );
  }

  // The wall clock is the Run's, not one invocation's (ADR-0017): resuming
  // must not be a way past `loop.totalTimeoutMs`.
  const total = readConfig(root).loop.totalTimeoutMs;
  if (!deps.interactive && record.elapsedMs >= total) {
    throw new Error(
      `${run.branch} has spent its whole wall clock (${Math.round(record.elapsedMs / 60000)} of ${Math.round(total / 60000)} min, loop.totalTimeoutMs): raise it in .e/config.json to resume it.`
    );
  }

  if (deps.runtime.isRunning(run.name)) {
    throw new Error(
      `${run.branch} is still running (container ${run.name}); resume it once it has ended.`
    );
  }
  const spool = brokerSpoolDirFor(deps.worktreesDir, run);
  if (fs.existsSync(spool)) {
    const waiting = listRecords(spool).filter(record =>
      IN_FLIGHT.has(record.taskState)
    );
    if (waiting.length > 0) {
      throw new Error(
        `${run.branch} has siblings still in flight: ${waiting.map(r => r.id).join(', ')}. Let them finish (or cancel them) before resuming (ADR-0017).`
      );
    }
  }
  return { run, record, warnings };
}

function describeProvider(provider: RunSessionRecord['provider']): string {
  return provider
    ? `${provider.protocol} ${provider.baseUrl} ${provider.model}`
    : 'the harness default';
}

/** What a resume needs from the process it runs in; tests pass fakes. */
export interface ResumeCommandDeps {
  scratch: RunScratch;
  abort?: AbortSignal;
  git?: Git;
  runtime?: ContainerRunner;
}

/**
 * The whole `e resume`: preflight → gather (the Run's own agent, MCP servers
 * and skills, the follow-up as the prompt) → validate → the local stack →
 * plan → execute with the `resume` fact. Returns the exit code, like
 * `runSpawnCommand`.
 */
export async function runResumeCommand(
  branch: string,
  prompt: string[],
  opts: ResumeCommandOptions,
  deps: ResumeCommandDeps
): Promise<number> {
  const { scratch, abort } = deps;
  try {
    const git = deps.git ?? new HostGit();
    const runtime = deps.runtime ?? resolveRuntime(opts.runtime);
    const target = resolveResume(branch, opts, {
      git,
      runtime,
      worktreesDir: defaultWorktreesDir(),
      interactive: prompt.join(' ').trim() === '',
    });
    for (const warning of target.warnings) log.warn(warning);
    const { run, record } = target;

    const gathered = gatherSpawnFacts(run.agent, prompt, {
      ...opts,
      // The Run's sidecars are started again, empty (ADR-0017).
      mcp: record.mcp,
      skill: record.skills,
      // As disposable as a spawned one: the session lives in the host mount.
      // `resume` declares no --rm of its own, and without this the container
      // outlived the run under the run's name, so the next resume of that
      // run failed on "The container name ... is already in use".
      rm: true,
    });
    const resumed: SpawnFacts = {
      ...gathered,
      resume: {
        branch: run.branch,
        base: record.base,
        elapsedMs: record.elapsedMs,
      },
    };
    validateSpawn(resumed);
    const facts = await prepareLocalStack(resumed, {
      runtime,
      askForKey: promptForLocalApiKey,
    });
    const result = await executeSpawn(facts, planSpawn(facts), {
      git,
      runtime,
      scratch,
      pullRequest: facts.gitPlatform ? new HostPullRequest() : undefined,
      gitPlatform: facts.gitPlatform,
      abort,
    });
    scratch.dispose();
    for (const line of spawnReport(result)) log[line.level](line.text);
    return result.exitCode;
  } catch (err) {
    log.error(errorMessage(err));
    return 1;
  } finally {
    scratch.dispose();
  }
}

export function registerResumeCommand(program: Command): void {
  program
    .command('resume')
    .description(
      `Continue an earlier run's harness session on its own branch (${resumableHarnessNames().join(', ')})`
    )
    .argument('<branch>', 'the run branch, e/<agent>/<slug>-N')
    .argument(
      '[prompt...]',
      'follow-up for the resumed session (omit it to reopen the TUI)'
    )
    .option(
      `${SPAWN_FLAGS.runtime} <runtime>`,
      `container runtime to use: ${RUNTIME_NAMES.join(', ')} (default: $E_RUNTIME, else the first one on PATH)`
    )
    .option(
      `${SPAWN_FLAGS.envFile} <path>`,
      'load environment variables from a file'
    )
    .option(`${SPAWN_FLAGS.dir} <path>`, 'root directory holding the Store')
    .option(
      SPAWN_FLAGS.rebuild,
      'build every image the run needs (the default)'
    )
    .option(
      SPAWN_FLAGS.noRebuild,
      'build only the images that are missing or off the version pin'
    )
    .option(SPAWN_FLAGS.keepWorktree, 'keep the worktree after container exits')
    .option(
      '-e, --env <env>',
      'set an environment variable, e.g. KEY=value (repeatable)',
      collectRepeatable
    )
    .action(
      async (branch: string, prompt: string[], opts: ResumeCommandOptions) => {
        const scratch = new RunScratch();
        // SIGTERM and SIGINT are a cancel, exactly as for `e spawn` (ADR-0015).
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
        process.exit(
          await runResumeCommand(branch, prompt, opts, {
            scratch,
            abort: cancel.signal,
          })
        );
      }
    );
}
