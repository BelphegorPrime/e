import type { Git } from '../../ports/git/index.js';
import type { PullRequest } from '../../ports/github/index.js';
import type {
  GitPlatform,
  LoopCaps,
  VerifyConfig,
} from '../../core/store/config.js';
import { DEFAULT_LOOP_CAPS } from '../../core/store/config.js';
import type {
  ContainerRunner,
  RunOptions,
  SidecarSpec,
  Mount,
} from '../../ports/runtime/index.js';
import type { Harness } from '../../core/harness/index.js';
import type { Agent } from '../../core/agent/index.js';
import { slugify } from '../../core/identity/slugify.js';
import { nextRunName } from './nextRunName.js';
import {
  sidecarContainerFor,
  verifyContainerFor,
  type RunName,
} from '../../core/identity/runName.js';
import { runVerify, type VerifyOutcome } from './runVerify.js';
import { verifyFeedback } from './verifyFeedback.js';

import { waitForAllReady, type ReadinessPolicy } from './runSidecars.js';
import { worktreePathFor } from './worktreesDir.js';
import { runRoleInstructions, type RunRole } from '../runRole.js';
import {
  artifactsDirFor,
  removeArtifacts,
  syncArtifacts,
} from './runArtifacts.js';
import { log } from '../../shared/utils/log.js';
import type { SiblingStatusPatch } from '../../sidecars/broker/contract/types.js';
import { DEFAULT_MAX_SIBLINGS } from '../../core/store/config.js';
import {
  DEFAULT_SIBLING_READINESS,
  SiblingConsumer,
  type SiblingOutcome,
} from './runSiblings.js';
import { reportChildRun, type ChildLauncher } from './childRun.js';
import {
  brokerSidecarSpec,
  brokerSpoolDirFor,
  prepareBrokerSpool,
  removeBrokerSpool,
} from './runBroker.js';
import type { BrokerPlan, SidecarPlan } from '../sidecarPlan.js';

import { errorMessage } from '../../shared/utils/errors.js';
export type { ReadinessPolicy } from './runSidecars.js';

/** The exit code of a canceled run (SIGTERM's 128 + 15), so no commit path takes it for a success. */
export const CANCELED_EXIT_CODE = 143;

/**
 * A run that ended on something other than its own verdict (ADR-0016): the
 * harness died, it was OOM-killed, or the check could not run. Generic on
 * purpose - it is the code `e` already uses for a failure.
 */
export const ABORTED_EXIT_CODE = 1;

/**
 * A run that spent its budget with the check still red. Distinct from
 * {@link ABORTED_EXIT_CODE} because it is the one outcome a caller plausibly
 * branches on: "out of budget, maybe re-queue with more" is a different
 * reaction from "it broke".
 */
export const EXHAUSTED_EXIT_CODE = 2;

/** Readiness polling defaults: up to 30 tries, 1s apart (~30s), overridable per run. */
const DEFAULT_READINESS_ATTEMPTS = 30;
const DEFAULT_READINESS_INTERVAL_MS = 1000;

/** Tells one-shot harnesses that the host owns Git for their disposable worktree. */
export const RUN_GIT_INSTRUCTIONS =
  'You are working in an e-managed Git worktree. Do not run git add, git commit, git push, or git worktree: Git metadata and credentials intentionally remain on the host. Make requested file changes only; e will capture, commit, and push them after the run.';

/**
 * The one-shot launch prompt: e's worktree rules, the role contract (ADR-0013:
 * check `$E_ROLE` / `$E_BROKER_URL`, no marker files), then the task itself.
 */
export function launchPrompt(
  prompt: string,
  role: RunRole = 'parent',
  verify?: VerifyConfig
): string {
  // Iteration 1 states the acceptance criterion up front, or the first attempt
  // flies blind against a bar that was knowable in advance - with the caveat
  // that the check runs in a container this one cannot reproduce (the harness
  // images are alpine/musl and the check installs its own dependencies), so
  // failing to run it locally says nothing about the work.
  const gate = verify
    ? `\n\nWhen your run ends, e runs \`${verify.command}\` in a separate container against this worktree; its exit code decides whether the work is accepted. That container is not this one - do not assume you can run the command here.`
    : '';
  return `${RUN_GIT_INSTRUCTIONS}\n${runRoleInstructions(role)}${gate}\n\n${prompt}`;
}

/** What the orchestrator needs to build a run. */
export interface RunSpawnDeps {
  git: Git;
  runtime: ContainerRunner;
  pullRequest?: PullRequest;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The run a sibling is requested from (ADR-0013). Its worktree is the live
 * `/workspace` of a running agent; before the sibling branches off, the host
 * commits whatever is uncommitted there (the **checkpoint**), so the sibling
 * starts from exactly what the parent sees - ADR-0001 worktrees only carry
 * committed state. No agent action is involved.
 */
export interface ParentRun {
  /** Host path of the parent's worktree. */
  worktreePath: string;
  /** The parent's run branch (`e/<agent>/<slug>-N`), named in the checkpoint commit. */
  branch: string;
  /**
   * Build artifacts to copy from the parent worktree into the sibling's
   * container: the store's `siblingArtifacts` (`config.json`, default
   * `node_modules`). `.env` and `.git` are never copied whatever is listed
   * (ADR-0002); an empty list syncs nothing.
   */
  artifacts: readonly string[];
}

/** Full parameters for a runSpawn call. */
export interface RunSpawnParams {
  name?: string;
  prompt: string;
  imageTag: string;
  interactive?: boolean;
  model?: string;
  agent: Agent;
  harness: Harness;
  runOptions: RunOptions;
  sidecars?: SidecarPlan[];
  mcpArgs?: string[];
  configMounts?: Mount[];
  readiness?: ReadinessPolicy;
  gitPlatform?: GitPlatform;
  /**
   * Where worktrees are created. Required: the rule (`E_WORKTREES_DIR` or the
   * platform default) belongs to `worktreesDir.ts` and is applied once, by the
   * caller that gathers it - a second `?? defaultWorktreesDir()` here is a
   * second place for that decision to drift.
   */
  worktreesDir: string;
  /** Leave the worktree in place after the run instead of removing a clean one. */
  keepWorktree?: boolean;
  /** The role named in the launch prompt (`parent` by default); the env is the plan's. */
  role?: RunRole;
  /** The runtime-broker sidecar to bring up with the run (ADR-0013), if planned. */
  broker?: BrokerPlan;
  /**
   * Present for a sibling run: the parent whose worktree is checkpointed and
   * whose branch tip the sibling branches from, instead of the host's HEAD.
   */
  parent?: ParentRun;
  /**
   * Present for a sibling run: where it reports its status (`running` with
   * its branch, then `done` or `failed`) - the parent's spool and its request
   * id. A sibling neither pushes nor opens a PR: its delivery is the merge
   * back into the parent (ADR-0013).
   */
  sibling?: { spoolDir: string; id: string };
  /**
   * Present for a run of the user's own that something else watches (the A2A
   * facade of `e serve`, ADR-0015): a spool and request id to report the same
   * status into, plus `pushed` and the PR/MR URL at the end. Unlike `sibling`
   * it changes nothing else about the run.
   */
  report?: { spoolDir: string; id: string };
  /**
   * A cancel (ADR-0015): aborted before the container starts, the run ends
   * without one; aborted while the container runs, the host removes it, so
   * `runtime.run` returns and the normal teardown follows. Nothing is
   * committed for a run that did not exit 0.
   */
  abort?: AbortSignal;
  /** Fan-out bound for a run with a broker (`config.json` `maxSiblings`; default 3). */
  maxSiblings?: number;
  /**
   * The repository's verify command (ADR-0016). Declared, it gates the run:
   * the check runs in a second container once the work is committed, and its
   * verdict - not the harness's exit code - decides whether a PR is opened.
   * Absent, the run ends exactly as it did before the gate existed.
   */
  verify?: VerifyConfig;
  /** The Store's package-cache volume, when the verify declaration opts in. */
  cacheVolume?: string;
  /**
   * The Store's `loop` block (ADR-0016): the attempt budget and the wall
   * clocks. `iterationTimeoutMs` applies to every non-interactive run, the
   * rest only where a gate is declared. Absent, the built-in defaults apply.
   */
  loop?: LoopCaps;
  /**
   * How this run hosts siblings (with a broker): the poll/readiness pacing,
   * what every sibling `e spawn` inherits from this invocation, and the
   * launcher. Required whenever `broker` is set - there is no default
   * launcher, on purpose: the production one re-invokes the CLI, and a caller
   * that did not choose it (a test) must never end up spawning processes.
   */
  siblingHost?: {
    readiness?: ReadinessPolicy;
    passthroughArgs?: string[];
    passthroughEnv?: Record<string, string>;
    launch: ChildLauncher;
  };
}

/** How a gated run's loop ended (ADR-0016). */
export type LoopOutcome = 'verified' | 'exhausted' | 'aborted';

/**
 * Why it ended that way. Spelled out because the two kills that matter are
 * indistinguishable from outside: an OOM and our own wall-clock SIGKILL both
 * end the container on 137, and only the host knows whether a timer fired.
 */
export type LoopReason =
  | 'exhausted:iterations'
  | 'exhausted:iteration-timeout'
  | 'exhausted:total-timeout'
  | 'aborted:oom'
  | 'aborted:harness-exit'
  | 'aborted:verify-broken';

/** What one attempt of the loop did. */
export interface IterationOutcome {
  /** 1-based; the same ordinal the agent is told. */
  attempt: number;
  /** What the harness container exited with - liveness, never a verdict. */
  harnessExitCode: number;
  /** The commit this attempt left, absent when the container died. */
  commit?: string;
  /** The check's verdict, absent when the attempt never reached it. */
  verdict?: VerifyOutcome['verdict'];
  /** What the check exited with. */
  verifyExitCode?: number;
}

/** Orchestrated run output. */
export interface RunSpawnResult {
  ran: boolean;
  exitCode: number;
  captured?: boolean;
  branch?: string;
  /** The commit the run branched from (a checkpoint sha for a sibling). */
  base?: string;
  pushed?: boolean;
  pushWarning?: string;
  pullRequestUrl?: string;
  pullRequestWarning?: string;
  /**
   * For a run with a broker: every sibling it requested, with how its work
   * reached this run's worktree (the merge-back of ticket 07).
   */
  siblings?: SiblingOutcome[];
  /** The gate's verdict, for a run that declared one (ADR-0016). */
  verify?: VerifyOutcome;
  /**
   * One entry per attempt, for a gated run (ADR-0016); undefined without a
   * gate, so a run that declared none produces exactly the result it always
   * did, with no new field for a caller to read.
   */
  iterations?: IterationOutcome[];
  /**
   * How the loop ended, stated rather than derived from the last entry -
   * the report leads with it, and reconstructing it is the kind of inference
   * that goes wrong.
   */
  outcome?: LoopOutcome;
  /** Why the loop ended that way (ADR-0016). */
  reason?: LoopReason;
  /**
   * The soft total-timeout mark, passed at an attempt boundary. A warning for
   * the human only: it stops nothing, and it never reaches the prompt.
   */
  softTimeoutWarning?: string;
  error?: string;
}

/**
 * The checkpoint of ADR-0013: commit the parent worktree's uncommitted work on
 * its own branch (host-side, no agent involvement) and return the tip the
 * sibling branches from. A clean parent needs no commit; its tip is the base.
 */
function checkpointParent(git: Git, parent: ParentRun, slug: string): string {
  // `commitAll` on a worktree with `MERGE_HEAD` set would conclude the
  // merge-back in progress there, markers and all: the parent has a conflict
  // to resolve and signal before it can spawn again.
  if (git.mergeInProgress(parent.worktreePath)) {
    throw new Error(
      `Could not checkpoint ${parent.branch} before spawning ${slug}: a merge-back is in progress in the parent worktree; resolve its conflict and signal --merge first`
    );
  }
  if (git.isDirty(parent.worktreePath)) {
    try {
      git.commitAll(
        parent.worktreePath,
        `e: checkpoint ${parent.branch} before spawning ${slug}`
      );
    } catch (err) {
      // Nothing of the sibling exists yet; the parent keeps its work (staged
      // by the attempt) and the request fails with the reason attached.
      throw new Error(
        `Could not checkpoint ${parent.branch} before spawning ${slug}: ${errorMessage(err)}`,
        { cause: err }
      );
    }
  }
  return git.headSha(parent.worktreePath);
}

/** Main run spawn orchestrator. Builds production managers from primitives. */
export async function runSpawn(
  deps: RunSpawnDeps,
  params: RunSpawnParams
): Promise<RunSpawnResult> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

  const readinessAttempts =
    params.readiness?.attempts ?? DEFAULT_READINESS_ATTEMPTS;

  const readinessIntervalMs =
    params.readiness?.intervalMs ?? DEFAULT_READINESS_INTERVAL_MS;

  const { worktreesDir } = params;

  // Track what was started so best-effort teardown never touches
  // resources that were never created (e.g. when createNetwork fails).
  let branch: string | undefined;
  let worktreePath: string | undefined;
  let network: string | undefined;
  let openedNetwork = false;
  let startedSpecs: SidecarSpec[] = [];
  // Host-side scratch a run leaves behind (a sibling's synced artifacts, the
  // broker spool); removed at teardown unless the worktree is kept too.
  const scratch: Array<() => void> = [];
  // The consumer of sibling requests and its spool, for a run that has a broker.
  let consumer: SiblingConsumer | undefined;
  let consumerStopped = false;
  // The gate writes its own dependencies into the worktree, so once it has
  // run, what is left uncommitted there is the check's and not the run's.
  let gateRan = false;
  // The run's total wall clock (ADR-0016). Hoisted so teardown can drop it on
  // every path out, including a throw: a live timer outlives the run.
  let loopTimer: ReturnType<typeof setTimeout> | undefined;
  let brokerSpool: string | undefined;
  const role = params.role ?? 'parent';
  const maxSiblings = params.maxSiblings ?? DEFAULT_MAX_SIBLINGS;
  if (params.broker && !params.siblingHost?.launch) {
    throw new Error(
      'A run with a broker needs siblingHost.launch: refusing to host siblings without a launcher'
    );
  }

  /** A sibling reports into its parent's spool, a watched run into its watcher's; every other run has nowhere to. */
  const reportTo = params.sibling ?? params.report;
  const report = (patch: Omit<SiblingStatusPatch, 'updatedAt'>): void =>
    reportChildRun(reportTo, patch);

  try {
    const slug = params.name ?? slugify(params.prompt);
    // Pin the base before creating the worktree: the host's HEAD - or, for a
    // sibling, the parent worktree's tip once its WIP is checkpointed there.
    const base = params.parent
      ? checkpointParent(deps.git, params.parent, slug)
      : deps.git.headSha();
    const baseBranch = deps.git.currentBranch() || 'main';

    // Cut the branch and create the worktree atomically (collision-retry inside
    // `nextRunName`); every other name this run uses is derived from its identity.
    const run: RunName = await nextRunName(
      deps.git,
      params.agent,
      slug,
      base,
      worktreesDir
    );
    branch = run.branch;
    worktreePath = worktreePathFor(worktreesDir, run);
    // A sibling has its identity now: the parent's status shows the branch
    // before any image build or container.
    report({ status: 'starting', branch });

    // Artifact sync (ADR-0013): the sibling's worktree holds only committed
    // state, so the parent's gitignored build artifacts are copied into a
    // scratch dir now - after the worktree exists, before the container
    // starts - and bind-mounted at the same /workspace paths below. Never
    // into the worktree itself, so they can never land in the branch.
    const artifactMounts: Mount[] = [];
    if (params.parent) {
      const artifactsDir = artifactsDirFor(worktreesDir, run);
      scratch.push(() => removeArtifacts(artifactsDir));
      const synced = syncArtifacts({
        parentWorktree: params.parent.worktreePath,
        targetDir: artifactsDir,
        entries: params.parent.artifacts,
      });
      if (synced.copied.length > 0) {
        log.debug(
          `Synced ${synced.copied.join(', ')} from ${params.parent.branch} into ${run.name}`
        );
      }
      for (const entry of synced.refused) {
        log.warn(
          `Not syncing "${entry}" into ${run.name}: not a real path inside the parent worktree`
        );
      }
      for (const failure of synced.failed) {
        log.warn(
          `Could not sync "${failure.entry}" into ${run.name} (${failure.error}); the sibling can regenerate it`
        );
      }
      artifactMounts.push(...synced.mounts);
    }

    // Prepare sidecar specs. With the local stack present, sidecars join the
    // shared egress namespace like the agent does (ADR-0011), so their traffic
    // is logged and filtered too and the agent reaches them on loopback.
    // Without the stack they fall back to a private per-run network.
    const netns = params.runOptions.netns;
    const runNetwork = netns ? undefined : run.network;
    const sidecarPlans = params.sidecars ?? [];
    const specs: SidecarSpec[] = sidecarPlans.map(plan => ({
      name: sidecarContainerFor(run, plan.alias),
      alias: plan.alias,
      image: plan.image,
      port: plan.port,
      healthcheck: plan.healthcheck,
      netns,
      network: runNetwork,
      envFile: plan.envFile,
    }));

    // The runtime-broker (ADR-0013) rides along as one more sidecar. The host
    // owns its spool: the run's identity goes in before the broker starts, the
    // broker spools sibling requests there, and the directory goes with the run.
    if (params.broker) {
      const spool = brokerSpoolDirFor(worktreesDir, run);
      brokerSpool = spool;
      scratch.push(() => removeBrokerSpool(spool));
      prepareBrokerSpool(spool, {
        name: run.name,
        branch,
        agent: params.agent.name,
        role,
        maxSiblings,
      });
      specs.unshift(
        brokerSidecarSpec(params.broker, {
          run,
          netns,
          network: runNetwork,
          spoolDir: brokerSpool,
        })
      );
    }

    // Create the run network only when sidecars exist and no netns is shared.
    network = specs.length > 0 ? runNetwork : undefined;
    if (network) {
      deps.runtime.createNetwork(network);
      openedNetwork = true;
    }

    // Start sidecars and wait for each to be ready (probe first, sleep on miss).
    if (specs.length > 0) {
      for (const spec of specs) deps.runtime.startSidecar(spec);
      startedSpecs = specs;

      const { notReady } = await waitForAllReady(deps.runtime, specs, {
        attempts: readinessAttempts,
        intervalMs: readinessIntervalMs,
        sleep,
      });
      if (notReady.length > 0) {
        // Teardown happens in the finally block.
        return {
          ran: false,
          exitCode: 1,
          error: `Sidecar "${notReady[0].alias}" did not become ready in time`,
        };
      }
      // Ready is not alive: in the shared egress namespace the probe hits
      // whoever holds the port, so a sidecar that lost its port to another
      // run's sidecar (EADDRINUSE) would look ready while the agent talked to
      // a stranger's container. Insist that each one is still running.
      const dead = specs.find(spec => !deps.runtime.isRunning(spec.name));
      if (dead) {
        return {
          ran: false,
          exitCode: 1,
          error: `Sidecar "${dead.alias}" exited right after starting; in the shared egress namespace its port may already be taken by another run`,
        };
      }
    }

    // Build run options.
    const joinedNetworks: string[] | undefined = params.runOptions.netns
      ? undefined
      : (() => {
          const nets = new Set<string>([
            ...(params.runOptions.networks ?? []),
            ...(network ? [network] : []),
          ]);
          return nets.size > 0 ? [...nets] : undefined;
        })();

    const runOptions: RunOptions = {
      ...params.runOptions,
      name: run.name,
      networks: joinedNetworks,
      volumes: [
        { host: worktreePath, container: '/workspace' },
        ...artifactMounts,
        ...(params.configMounts ?? []),
      ],
      workdir: '/workspace',
    };

    // With the broker up, sibling requests can arrive: the host picks them up
    // from the spool for as long as the agent runs (ADR-0013). The consumer
    // re-invokes this CLI per request; each sibling checkpoints this worktree
    // and branches from it.
    if (brokerSpool && worktreePath) {
      consumer = new SiblingConsumer({
        spoolDir: brokerSpool,
        parent: { worktreePath, branch, network, role },
        maxSiblings,
        readiness: params.siblingHost?.readiness ?? DEFAULT_SIBLING_READINESS,
        passthroughArgs: params.siblingHost?.passthroughArgs,
        passthroughEnv: params.siblingHost?.passthroughEnv,
        launch: params.siblingHost!.launch,
        sleep,
        git: deps.git,
      });
      consumer.start();
    }

    // A cancel that arrived before the container exists ends the run here:
    // nothing ran, nothing to commit (ADR-0015).
    if (params.abort?.aborted) {
      report({
        status: 'failed',
        branch,
        error: 'canceled before the container started',
      });
      return {
        ran: false,
        exitCode: CANCELED_EXIT_CODE,
        branch,
        base,
        error: 'Run canceled before the container started',
      };
    }

    // A sibling is now identifiable: report it running under its branch.
    report({ status: 'running', branch });

    const onAbort = (): void => {
      log.warn(`Run ${run.name} canceled: stopping its container`);
      deps.runtime.removeContainer(run.name);
    };

    // The loop (ADR-0016): one attempt is launch -> harness run -> commit ->
    // verify -> feedback, in a fresh container each time, with the worktree
    // carrying the context. A run with no gate is a loop of length one, which
    // is exactly what a run has always been - so nothing below changes for it.
    const gated = !!params.verify && !params.sibling && !params.interactive;
    const caps = params.loop ?? DEFAULT_LOOP_CAPS;
    const maxIterations = gated ? caps.maxIterations : 1;

    let exitCode = 0;
    let captured = false;
    let verifyOutcome: VerifyOutcome | undefined;
    let feedback = '';
    const iterations: IterationOutcome[] = [];
    let outcome: LoopOutcome = 'exhausted';
    let reason: LoopReason = 'exhausted:iterations';
    let softTimeoutWarning: string | undefined;

    // Which wall clock we pulled the plug on, if either. An OOM and our own
    // SIGKILL both end the container on 137, so this flag is the only thing
    // that tells them apart - and `removeContainer` is best-effort, so two
    // timers expiring at once cost nothing: whoever fires first wins.
    let killedBy: 'iteration' | 'total' | undefined;
    const killNow = (which: 'iteration' | 'total') => (): void => {
      killedBy ??= which;
      log.warn(`Run ${run.name} hit its ${which} time limit: stopping it`);
      deps.runtime.removeContainer(run.name);
    };
    // The hard total kills mid-attempt on purpose. Checking only at the
    // boundary cannot keep its promise: with 2h total and 30min per attempt,
    // one starting at 1h59 still sees budget and runs to 2h29.
    const totalTimer = params.interactive
      ? undefined
      : setTimeout(killNow('total'), caps.totalTimeoutMs);
    loopTimer = totalTimer;
    const startedAt = Date.now();

    for (let attempt = 1; attempt <= maxIterations; attempt++) {
      // The soft mark only warns, and only to the human - never into the
      // prompt, for the same reason the agent is not told its budget.
      if (
        caps.softTotalTimeoutMs !== undefined &&
        attempt > 1 &&
        Date.now() - startedAt >= caps.softTotalTimeoutMs
      ) {
        softTimeoutWarning = `Past the soft time limit (${Math.round(caps.softTotalTimeoutMs / 60000)} min) at attempt ${attempt}; the hard limit is ${Math.round(caps.totalTimeoutMs / 60000)} min.`;
        log.warn(softTimeoutWarning);
      }
      const command = params.interactive
        ? params.harness.buildInteractiveCommand(params.model)
        : params.harness.buildCommand(
            // The task is restated in full every time: a fresh container has
            // no conversational memory, and the feedback is a suffix so the
            // composition above it stays intact.
            launchPrompt(params.prompt, role, params.verify) + feedback,
            params.model
          );

      // Execute the agent container in the foreground. A cancel while it runs
      // removes the container, so `run` returns (non-zero) and teardown follows.
      params.abort?.addEventListener('abort', onAbort, { once: true });
      // A hung container is the same problem gated or not, so this covers
      // every non-interactive run; killing a human's live session at half an
      // hour would be hostile.
      const iterationTimer = params.interactive
        ? undefined
        : setTimeout(killNow('iteration'), caps.iterationTimeoutMs);
      try {
        exitCode = await deps.runtime.run(params.imageTag, runOptions, [
          ...command,
          ...(params.mcpArgs ?? []),
        ]);
      } finally {
        if (iterationTimer) clearTimeout(iterationTimer);
        params.abort?.removeEventListener('abort', onAbort);
      }
      if (params.abort?.aborted && exitCode === 0)
        exitCode = CANCELED_EXIT_CODE;

      // A kill of ours is a third case, not a crash: the host knows it caused
      // this one, at a moment of its own choosing, so the worktree holds what
      // the agent had at minute 30 rather than what survived an unknown fault.
      // Nothing is fed forward - the run ends - so keeping it is not the same
      // act as using a half-state as input.
      if (killedBy) {
        if (deps.git.isDirty(worktreePath)) {
          deps.git.commitAll(
            worktreePath,
            `e: timed-out attempt ${attempt} for ${branch}`
          );
          captured = true;
        }
        outcome = 'exhausted';
        reason =
          killedBy === 'total'
            ? 'exhausted:total-timeout'
            : 'exhausted:iteration-timeout';
        if (gated) {
          iterations.push({
            attempt,
            harnessExitCode: exitCode,
            ...(captured ? { commit: deps.git.headSha(worktreePath) } : {}),
          });
        }
        break;
      }

      // Liveness, never a verdict: the container died, so nothing of this
      // attempt is committed and the loop does not retry - that would start a
      // fresh container on top of a half-finished edit nobody reconciled.
      if (exitCode !== 0) {
        outcome = 'aborted';
        // 137 with no timer of ours fired is the kernel's doing, and too
        // little memory is not something an attempt can fix.
        reason = exitCode === 137 ? 'aborted:oom' : 'aborted:harness-exit';
        if (gated) iterations.push({ attempt, harnessExitCode: exitCode });
        break;
      }

      if (deps.git.isDirty(worktreePath)) {
        // With a merge-back conflict still in progress this commit concludes
        // it as the merge commit - with whatever the agent left in the files.
        deps.git.commitAll(worktreePath, `e: run output for ${branch}`);
        captured = true;
      }

      if (!gated) break;

      // The gate, after the commit: the check installs its own dependencies
      // into the worktree, so checking afterwards is what keeps them out of
      // the run's history.
      gateRan = true;
      verifyOutcome = await runVerify(
        { runtime: deps.runtime },
        {
          verify: params.verify!,
          worktreePath,
          harnessImage: params.imageTag,
          containerName: verifyContainerFor(run),
          netns: runOptions.netns,
          networks: runOptions.networks,
          cacheVolume: params.cacheVolume,
          // The check runs a foreign repository's test suite, which is the
          // larger OOM risk of the two containers.
          resources: {
            memory: runOptions.memory,
            cpus: runOptions.cpus,
            pidsLimit: runOptions.pidsLimit,
          },
        }
      );
      iterations.push({
        attempt,
        harnessExitCode: exitCode,
        commit: deps.git.headSha(worktreePath),
        verdict: verifyOutcome.verdict,
        verifyExitCode: verifyOutcome.exitCode,
      });

      if (verifyOutcome.verdict === 'green') {
        outcome = 'verified';
        break;
      }
      if (verifyOutcome.verdict === 'broken') {
        // Iterating against a check that never ran burns the budget to learn
        // nothing, and reports a red the agent cannot act on.
        outcome = 'aborted';
        reason = 'aborted:verify-broken';
        break;
      }
      feedback = verifyFeedback({
        attempt,
        command: params.verify!.command,
        exitCode: verifyOutcome.exitCode,
        output: verifyOutcome.output,
        timedOut: verifyOutcome.reason === 'timeout',
      });
    }

    // The agent is done: stop taking sibling requests and wait for the
    // siblings in flight (each is merged back as it exits), so nothing of
    // theirs outlives the run's network.
    if (consumer) {
      await consumer.stop();
      consumerStopped = true;
    }

    // The loop is over: drop the total timer, or it outlives the run and keeps
    // the process alive for its full duration.
    if (totalTimer) clearTimeout(totalTimer);

    // Push a run of the user's own - a sibling's work reaches the parent by
    // merge-back.
    let pushed = false;
    let pushWarning: string | undefined;
    const canceled =
      exitCode === CANCELED_EXIT_CODE || params.abort?.aborted === true;
    if (exitCode === 0) {
      // The tree is quiet and committed: the last retry of every merge-back
      // held over files in flight (ticket 07), before the branch is pushed so
      // the merge commits travel with it. Each retry rewrites its report in
      // the worktree, so what it left is committed too.
      if (consumer) {
        consumer.finish();
        if (deps.git.isDirty(worktreePath)) {
          deps.git.commitAll(
            worktreePath,
            `e: merge-back reports for ${branch}`
          );
          captured = true;
        }
      }
    }
    // The push no longer hangs on the harness's exit code (ADR-0016): an
    // exhausted run exits non-zero and its attempts are exactly what a human
    // needs to read, so anything that produced commits travels. A cancel does
    // not (ADR-0015), and a sibling's work reaches its parent by merge-back.
    if (
      !params.sibling &&
      !canceled &&
      (captured || deps.git.hasCommitsBeyondBase(branch, base))
    ) {
      try {
        deps.git.push(branch);
        pushed = true;
      } catch (err) {
        pushWarning = `could not push ${branch}: ${errorMessage(err)}`;
      }
    }

    // Open a PR/MR when a platform is configured and the branch was pushed.
    let pullRequestUrl: string | undefined;
    let pullRequestWarning: string | undefined;
    // A run that did not end verified has nothing to propose: the branch is
    // pushed so the attempts survive, and no PR claims they were accepted.
    const gateFailed = gated && outcome !== 'verified';
    if (params.gitPlatform && pushed && deps.pullRequest && !gateFailed) {
      const log = deps.git.runLog(branch);
      const title =
        log.length > 0 ? log[0].subject : `e: run output for ${branch}`;
      // A PR/MR that cannot be opened is a warning, never a failed run: the
      // branch is pushed and the work is safe either way.
      try {
        pullRequestUrl = deps.pullRequest.create({
          platform: params.gitPlatform,
          head: branch,
          base: baseBranch,
          title,
          body: params.prompt,
        });
      } catch (error) {
        pullRequestWarning = `could not open a ${params.gitPlatform} merge request for ${branch}: ${errorMessage(error)}`;
      }
    }

    // For a gated run `exitCode` is the *run's* verdict rather than the
    // harness's, which says only that the process finished (ADR-0016).
    // Outside a loop it stays what it always was.
    if (gated && outcome !== 'verified') {
      exitCode =
        outcome === 'exhausted' ? EXHAUSTED_EXIT_CODE : ABORTED_EXIT_CODE;
    }

    report({
      status: 'done',
      branch,
      exitCode,
      ...(params.report ? { pushed } : {}),
      ...(pullRequestUrl !== undefined ? { pullRequestUrl } : {}),
    });

    return {
      ran: true,
      exitCode,
      captured,
      branch,
      base,
      pushed,
      pushWarning,
      pullRequestUrl,
      pullRequestWarning,
      ...(consumer ? { siblings: consumer.outcomes } : {}),
      ...(verifyOutcome ? { verify: verifyOutcome } : {}),
      ...(gated ? { iterations, outcome, reason } : {}),
      ...(softTimeoutWarning ? { softTimeoutWarning } : {}),
    };
  } catch (err) {
    report({ status: 'failed', branch, error: errorMessage(err) });
    throw err;
  } finally {
    if (loopTimer) clearTimeout(loopTimer);
    // Best-effort teardown: never mask a result or an aborting error.
    try {
      if (consumer && !consumerStopped) await consumer.stop();
      for (const spec of startedSpecs) deps.runtime.removeContainer(spec.name);
      if (openedNetwork) deps.runtime.removeNetwork(network as string);
      if (!params.keepWorktree) {
        for (const dispose of scratch) dispose();
      }
      // A dirty worktree is normally uncommitted run work and must not be
      // discarded. Once the gate has run, it is the check's own install
      // (`node_modules`, `.venv`, `target/`) instead: the run's work was
      // committed immediately before the check started, by construction.
      if (
        worktreePath &&
        !params.keepWorktree &&
        (gateRan || !deps.git.isDirty(worktreePath))
      ) {
        deps.git.removeWorktree(worktreePath);
      }
    } catch {
      // Teardown is best-effort.
    }
  }
}
