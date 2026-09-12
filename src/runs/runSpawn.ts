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
  brokerSidecarSpec,
  brokerSpoolDirFor,
  prepareBrokerSpool,
  removeBrokerSpool,
  type BrokerPlan,
} from './runBroker.js';

export type { ReadinessPolicy } from './runSidecarOrchestrator.js';

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
  error?: string;
}

/**
 * The checkpoint of ADR-0013: commit the parent worktree's uncommitted work on
 * its own branch (host-side, no agent involvement) and return the tip the
 * sibling branches from. A clean parent needs no commit; its tip is the base.
 */
function checkpointParent(git: Git, parent: ParentRun, slug: string): string {
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
  let brokerSpool: string | undefined;

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
      brokerSpool = brokerSpoolDirFor(worktreesDir, runName);
      prepareBrokerSpool(brokerSpool, {
        name: runName,
        branch,
        agent: params.agent.name,
        role: params.role ?? 'parent',
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
        ...(params.configMounts ?? []),
      ],
      workdir: '/workspace',
    };

    // Build command.
    const command = params.interactive
      ? params.harness.buildInteractiveCommand(params.model)
      : params.harness.buildCommand(
          launchPrompt(params.prompt, params.role),
          params.model
        );

    // Execute the agent container in the foreground.
    const exitCode = await deps.runtime.run(params.imageTag, runOptions, [
      ...command,
      ...(params.mcpArgs ?? []),
    ]);

    // Commit and push only when the run exited 0 and produced changes.
    let captured = false;
    let pushed = false;
    let pushWarning: string | undefined;
    if (exitCode === 0) {
      if (deps.git.isDirty(worktreePath)) {
        deps.git.commitAll(worktreePath, `e: run output for ${branch}`);
        captured = true;
      }
      if (captured || deps.git.hasCommitsBeyondBase(branch, base)) {
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
    };
  } finally {
    // Best-effort teardown: never mask a result or an aborting error.
    try {
      if (startedSpecs.length > 0) {
        await sidecarOrchestrator.stopAll(startedSpecs);
      }
      if (openedNetwork) {
        await networkManager.removeNetwork(network as string);
      }
      if (brokerSpool && !params.keepWorktree) {
        removeBrokerSpool(brokerSpool);
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
