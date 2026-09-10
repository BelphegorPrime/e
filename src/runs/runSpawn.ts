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
import { DockerSidecarOrchestrator } from './runSidecarOrchestrator.js';
import { ProductionContainerExecutor } from './runContainerExecution.js';
import { ProductionPullRequestManager } from './runPrManager.js';
import { ProductionLogCapture } from './runLogCapture.js';

/** Readiness polling defaults: up to 30 tries, 1s apart (~30s), overridable per run. */
const DEFAULT_READINESS_ATTEMPTS = 30;
const DEFAULT_READINESS_INTERVAL_MS = 1000;

/** Tells one-shot harnesses that the host owns Git for their disposable worktree. */
export const RUN_GIT_INSTRUCTIONS =
  'You are working in an e-managed Git worktree. Do not run git add, git commit, git push, or git worktree: Git metadata and credentials intentionally remain on the host. Make requested file changes only; e will capture, commit, and push them after the run.';

/** How readiness polling is paced: how many probe attempts, and the wait between them. */
export interface ReadinessPolicy {
  attempts: number;
  intervalMs: number;
}

/** A sidecar to bring up before the agent runs. */
export interface SidecarPlan {
  alias: string;
  image: string;
  port: number;
  healthcheck?: string[];
}

/** What the orchestrator needs to build a run. */
export interface RunSpawnDeps {
  git: Git;
  runtime: ContainerRunner;
  pullRequest?: PullRequest;
  sleep?: (ms: number) => Promise<void>;
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
  storeRoot?: string;
  worktreesDir?: string;
  keepWorktree?: boolean;
}

/** Orchestrated run output. */
export interface RunSpawnResult {
  ran: boolean;
  exitCode: number;
  captured?: boolean;
  branch?: string;
  pushed?: boolean;
  pushWarning?: string;
  pullRequestUrl?: string;
  pullRequestWarning?: string;
  sidecarWarnings?: string[];
  error?: string;
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

  const worktreesDir = params.worktreesDir ?? '/tmp/e-worktrees';

  // Construct production managers from the primitive deps.
  const branchNamer = new ProductionBranchNamer(deps.git, worktreesDir);
  const worktreeManager = new ProductionWorktreeManager(deps.git);
  const networkManager = new ProductionNetworkManager(deps.runtime);
  const sidecarOrchestrator = new DockerSidecarOrchestrator(deps.runtime);
  const containerExecutor = new ProductionContainerExecutor(deps.runtime);
  const logCapture = new ProductionLogCapture();

  // Track what was started so best-effort teardown never touches
  // resources that were never created (e.g. when createNetwork fails).
  let branch: string | undefined;
  let worktreePath: string | undefined;
  let network: string | undefined;
  let openedNetwork = false;
  let startedSpecs: SidecarSpec[] = [];

  try {
    // Pin the base to the commit HEAD points at now, before creating the worktree.
    const base = deps.git.headSha();
    const baseBranch = deps.git.currentBranch() || 'main';
    const slug = params.name ?? slugify(params.prompt);

    // Generate branch name and create worktree atomically (collision-retry inside the namer).
    ({ branch } = await branchNamer.nextBranch(params.agent, slug));
    worktreePath = `${worktreesDir}/${branch}`;
    const runName = branch.replace(/\//g, '-');

    // Prepare sidecar specs.
    const sidecarPlans = params.sidecars ?? [];
    const specs: SidecarSpec[] = sidecarPlans.map(plan => ({
      name: `${runName}-mcp-${plan.alias}`,
      alias: plan.alias,
      image: plan.image,
      port: plan.port,
      healthcheck: plan.healthcheck,
      network: `${runName}-net`,
      envFile: [`${worktreePath}/mcp.json`],
    }));

    // Create the run network when the agent needs to reach sidecars.
    network =
      specs.length > 0 && !params.runOptions.netns
        ? `${runName}-net`
        : undefined;
    if (network) {
      await networkManager.createNetwork(network);
      openedNetwork = true;
    }

    // Start sidecars and wait for each to be ready (probe first, sleep on miss).
    if (specs.length > 0) {
      await sidecarOrchestrator.startAll(specs);
      startedSpecs = specs;

      for (const spec of specs) {
        let ready = false;
        for (
          let attempt = 0;
          attempt < readinessAttempts && !ready;
          attempt++
        ) {
          if (sidecarOrchestrator.isSidecarReady(spec)) {
            ready = true;
          } else {
            await sleep(readinessIntervalMs);
          }
        }
        if (!ready) {
          // Teardown happens in the finally block.
          return {
            ran: false,
            exitCode: 1,
            error: `MCP sidecar "${spec.alias}" did not become ready in time`,
          };
        }
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
          `${RUN_GIT_INSTRUCTIONS}\n\n${params.prompt}`,
          params.model
        );

    // Execute the agent container in the foreground.
    const executionResult = await containerExecutor.execute(
      params.imageTag,
      runOptions,
      [...command, ...(params.mcpArgs ?? [])]
    );

    // Commit and push only when the run exited 0 and produced changes.
    let captured = false;
    let pushed = false;
    let pushWarning: string | undefined;
    if (executionResult.exitCode === 0) {
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

    // Capture egress logs when a store is configured.
    if (params.storeRoot) {
      await logCapture.captureEgressLogs(
        deps.runtime,
        params.storeRoot,
        branch
      );
    }

    // Detect sidecars that crashed mid-run (non-fatal warnings).
    const sidecarWarnings: string[] = [];
    for (const spec of startedSpecs) {
      if (!deps.runtime.isRunning(spec.name)) {
        sidecarWarnings.push(
          `MCP sidecar "${spec.alias}" exited during the run (its tools may have stopped working).`
        );
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
        deps.git,
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
      exitCode: executionResult.exitCode,
      captured,
      branch,
      pushed,
      pushWarning,
      pullRequestUrl,
      pullRequestWarning,
      sidecarWarnings: sidecarWarnings.length > 0 ? sidecarWarnings : undefined,
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
