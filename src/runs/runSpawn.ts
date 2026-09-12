import type { Git } from '../git/index.js';
import type { PullRequest } from '../github/index.js';
import type { GitPlatform } from '../store/config.js';
import type {
  ContainerRunner,
  RunOptions,
  SidecarSpec,
  Mount,
} from '../runtime/index.js';
import type { Harness } from '../harness/index.js';
import type { Agent } from '../agent/index.js';
import { slugify } from '../identity/slugify.js';
import { ProductionBranchNamer } from './runBranchNamer.js';
import { ProductionWorktreeManager } from './runWorktree.js';
import { ProductionNetworkManager } from './runNetworks.js';
import {
  DockerSidecarOrchestrator,
  type ReadinessPolicy,
} from './runSidecarOrchestrator.js';
import { ProductionPullRequestManager } from './runPrManager.js';
import { defaultWorktreesDir, worktreePathFor } from './worktreesDir.js';
import { runRoleInstructions, type RunRole } from './runRole.js';
import {
  artifactsDirFor,
  removeArtifacts,
  syncArtifacts,
} from './runArtifacts.js';
import { log } from '../utils/log.js';
import { writeStatus } from '../broker/spool.js';
import type { SiblingStatusPatch } from '../broker/types.js';
import { DEFAULT_MAX_SIBLINGS } from '../store/config.js';
import {
  DEFAULT_SIBLING_READINESS,
  SiblingConsumer,
  type SiblingLauncher,
  type SiblingOutcome,
} from './runSiblings.js';
import {
  brokerSidecarSpec,
  brokerSpoolDirFor,
  prepareBrokerSpool,
  removeBrokerSpool,
  type BrokerPlan,
} from './runBroker.js';

export type { ReadinessPolicy } from './runSidecarOrchestrator.js';

/** The exit code of a canceled run (SIGTERM's 128 + 15), so no commit path takes it for a success. */
export const CANCELED_EXIT_CODE = 143;

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
export function launchPrompt(prompt: string, role: RunRole = 'parent'): string {
  return `${RUN_GIT_INSTRUCTIONS}\n${runRoleInstructions(role)}\n\n${prompt}`;
}

/** A sidecar to bring up before the agent runs. */
export interface SidecarPlan {
  alias: string;
  image: string;
  port: number;
  healthcheck?: string[];
  /**
   * Env-files for the sidecar's own credentials (never the agent's). Wired at
   * execute time from the plan's `sidecarCredentials`; absent when the sidecar
   * needs none.
   */
  envFile?: string[];
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
  /** Where worktrees are created; default: the platform rule in `worktreesDir.ts`. */
  worktreesDir?: string;
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
    launch: SiblingLauncher;
  };
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
        `Could not checkpoint ${parent.branch} before spawning ${slug}: ${(err as Error).message}`,
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

  const worktreesDir = params.worktreesDir ?? defaultWorktreesDir();

  // Construct production managers from the primitive deps.
  const branchNamer = new ProductionBranchNamer(deps.git, worktreesDir);
  const worktreeManager = new ProductionWorktreeManager(deps.git);
  const networkManager = new ProductionNetworkManager(deps.runtime);
  const sidecarOrchestrator = new DockerSidecarOrchestrator(deps.runtime);

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
  const report = (patch: Omit<SiblingStatusPatch, 'updatedAt'>): void => {
    if (!reportTo) return;
    writeStatus(reportTo.spoolDir, reportTo.id, {
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  };

  try {
    const slug = params.name ?? slugify(params.prompt);
    // Pin the base before creating the worktree: the host's HEAD - or, for a
    // sibling, the parent worktree's tip once its WIP is checkpointed there.
    const base = params.parent
      ? checkpointParent(deps.git, params.parent, slug)
      : deps.git.headSha();
    const baseBranch = deps.git.currentBranch() || 'main';

    // Generate branch name and create worktree atomically (collision-retry inside the namer).
    ({ branch } = await branchNamer.nextBranch(params.agent, slug, base));
    worktreePath = worktreePathFor(worktreesDir, branch);
    const runName = branch.replace(/\//g, '-');
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
      const artifactsDir = artifactsDirFor(worktreesDir, runName);
      scratch.push(() => removeArtifacts(artifactsDir));
      const synced = syncArtifacts({
        parentWorktree: params.parent.worktreePath,
        targetDir: artifactsDir,
        entries: params.parent.artifacts,
      });
      if (synced.copied.length > 0) {
        log.debug(
          `Synced ${synced.copied.join(', ')} from ${params.parent.branch} into ${runName}`
        );
      }
      for (const entry of synced.refused) {
        log.warn(
          `Not syncing "${entry}" into ${runName}: not a real path inside the parent worktree`
        );
      }
      for (const failure of synced.failed) {
        log.warn(
          `Could not sync "${failure.entry}" into ${runName} (${failure.error}); the sibling can regenerate it`
        );
      }
      artifactMounts.push(...synced.mounts);
    }

    // Prepare sidecar specs. With the local stack present, sidecars join the
    // shared egress namespace like the agent does (ADR-0011), so their traffic
    // is logged and filtered too and the agent reaches them on loopback.
    // Without the stack they fall back to a private per-run network.
    const netns = params.runOptions.netns;
    const runNetwork = netns ? undefined : `${runName}-net`;
    const sidecarPlans = params.sidecars ?? [];
    const specs: SidecarSpec[] = sidecarPlans.map(plan => ({
      name: `${runName}-mcp-${plan.alias}`,
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
      const spool = brokerSpoolDirFor(worktreesDir, runName);
      brokerSpool = spool;
      scratch.push(() => removeBrokerSpool(spool));
      prepareBrokerSpool(spool, {
        name: runName,
        branch,
        agent: params.agent.name,
        role,
        maxSiblings,
      });
      specs.unshift(
        brokerSidecarSpec(params.broker, {
          runName,
          netns,
          network: runNetwork,
          spoolDir: brokerSpool,
        })
      );
    }

    // Create the run network only when sidecars exist and no netns is shared.
    network = specs.length > 0 ? runNetwork : undefined;
    if (network) {
      await networkManager.createNetwork(network);
      openedNetwork = true;
    }

    // Start sidecars and wait for each to be ready (probe first, sleep on miss).
    if (specs.length > 0) {
      await sidecarOrchestrator.startAll(specs);
      startedSpecs = specs;

      const { notReady } = await sidecarOrchestrator.waitForAllReady(specs, {
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
      name: runName,
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

    // Build command.
    const command = params.interactive
      ? params.harness.buildInteractiveCommand(params.model)
      : params.harness.buildCommand(
          launchPrompt(params.prompt, role),
          params.model
        );

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

    // Execute the agent container in the foreground. A cancel while it runs
    // removes the container, so `run` returns (non-zero) and teardown follows.
    const onAbort = (): void => {
      log.warn(`Run ${runName} canceled: stopping its container`);
      deps.runtime.removeContainer(runName);
    };
    params.abort?.addEventListener('abort', onAbort, { once: true });
    let exitCode: number;
    try {
      exitCode = await deps.runtime.run(params.imageTag, runOptions, [
        ...command,
        ...(params.mcpArgs ?? []),
      ]);
    } finally {
      params.abort?.removeEventListener('abort', onAbort);
    }
    if (params.abort?.aborted && exitCode === 0) exitCode = CANCELED_EXIT_CODE;

    // The agent is done: stop taking sibling requests and wait for the
    // siblings in flight (each is merged back as it exits), so nothing of
    // theirs outlives the run's network.
    if (consumer) {
      await consumer.stop();
      consumerStopped = true;
    }

    // Commit when the run exited 0 and produced changes; push only a run of
    // the user's own - a sibling's work reaches the parent by merge-back.
    let captured = false;
    let pushed = false;
    let pushWarning: string | undefined;
    if (exitCode === 0) {
      if (deps.git.isDirty(worktreePath)) {
        // With a merge-back conflict still in progress this commit concludes
        // it as the merge commit - with whatever the agent left in the files.
        deps.git.commitAll(worktreePath, `e: run output for ${branch}`);
        captured = true;
      }
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
      if (
        !params.sibling &&
        (captured || deps.git.hasCommitsBeyondBase(branch, base))
      ) {
        try {
          deps.git.push(branch);
          pushed = true;
        } catch (err) {
          pushWarning = `could not push ${branch}: ${(err as Error).message}`;
        }
      }
    }

    // Open a PR/MR when a platform is configured and the branch was pushed.
    let pullRequestUrl: string | undefined;
    let pullRequestWarning: string | undefined;
    if (params.gitPlatform && pushed && deps.pullRequest) {
      const log = deps.git.runLog(branch);
      const title =
        log.length > 0 ? log[0].subject : `e: run output for ${branch}`;
      const prResult = await new ProductionPullRequestManager(
        deps.pullRequest
      ).create({
        platform: params.gitPlatform,
        head: branch,
        base: baseBranch,
        title,
        body: params.prompt,
      });
      pullRequestUrl = prResult.url || undefined;
      pullRequestWarning = prResult.warning;
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
    };
  } catch (err) {
    report({ status: 'failed', branch, error: (err as Error).message });
    throw err;
  } finally {
    // Best-effort teardown: never mask a result or an aborting error.
    try {
      if (consumer && !consumerStopped) await consumer.stop();
      if (startedSpecs.length > 0) {
        await sidecarOrchestrator.stopAll(startedSpecs);
      }
      if (openedNetwork) {
        await networkManager.removeNetwork(network as string);
      }
      if (!params.keepWorktree) {
        for (const dispose of scratch) dispose();
      }
      if (
        worktreePath &&
        !params.keepWorktree &&
        !deps.git.isDirty(worktreePath)
      ) {
        await worktreeManager.removeWorktree(worktreePath);
      }
    } catch {
      // Teardown is best-effort.
    }
  }
}
