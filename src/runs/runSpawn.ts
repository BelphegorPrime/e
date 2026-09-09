import { slugify } from '../identity/slugify.js';
import type { RunBranchNamer } from './runBranchNamer.ts';
import type { WorktreeManager } from './runWorktree.ts';
import type { NetworkManager } from './runNetworks.ts';
import type { SidecarOrchestrator } from './runSidecarOrchestrator.ts';
import type { ContainerExecutor } from './runContainerExecution.ts';
import type { PullRequestManager } from './runPrManager.ts';
import type { LogCapture } from './runLogCapture.ts';
import type { RunResult } from './runResult.ts';

/** How many counter collisions to absorb before giving up (a runaway guard). */
const MAX_COUNTER_ATTEMPTS = 50;

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

/**
 * A sidecar to bring up for this Run, as the spawn edge knows it — before the
 * global egress namespace and turns each plan into a sidecar spec.
 */
export interface SidecarPlan {
  /** The MCP server's short name = network alias = URL host the agent reaches. */
  alias: string;
  /** The sidecar's image tag (built from `.e/mcp/<name>/Dockerfile`). */
  image: string;
  /** TCP port allocated for this run's global loopback namespace. */
  port: number;
  /** Optional in-container readiness command; readiness also requires it to exit 0. */
  healthcheck?: string[];
  /** Env vars this server's wiring needs, resolved from `.e/.env` at runtime. */
  requiredEnv?: string[];
  /** Optional HTTP headers for the sidecar. */
  headers?: Record<string, string>;
}

/** Run spawn dependencies with all extracted modules. */
export interface RunSpawnDeps {
  git: Git;
  runtime: ContainerRunner;
  harness: Harness;
  agent: Agent;
  pullRequest: PullRequest;
  worktreeManager: WorktreeManager;
  networkManager: NetworkManager;
  sidecarOrchestrator: SidecarOrchestrator;
  containerExecutor: ContainerExecutor;
  pullRequestManager: PullRequestManager;
  logCapture: LogCapture;
  runResult: RunResult;
  branchNamer: RunBranchNamer;
}

/** Run spawn parameters interface. */
export interface RunSpawnParams {
  name?: string;
  prompt: string;
  imageTag: string;
  interactive: boolean;
  model: string;
  agent: Agent;
  runOptions: RunOptions;
  sidecars?: SidecarPlan[];
  mcpArgs?: string[];
  configMounts?: Mount[];
  readiness?: ReadinessPolicy;
  gitPlatform?: GitPlatform;
  storeRoot?: string;
  worktreesDir?: string;
}

/** Run spawn result interface. */
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

/** Main run spawn orchestrator using extracted modules. */
export async function runSpawn(
  deps: RunSpawnDeps,
  params: RunSpawnParams
): Promise<RunSpawnResult> {
  const {
    sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms)),
  } = deps;

  const readinessAttempts = params.readiness?.attempts ?? DEFAULT_READINESS_ATTEMPTS;
  const readinessIntervalMs = params.readiness?.intervalMs ?? DEFAULT_READINESS_INTERVAL_MS;

  try {
    // Generate branch name using extracted branch namer
    const { branch } = await deps.branchNamer.nextBranch(params.agent, params.prompt);
    const branchName = `e/${params.agent.name}/${branch}`;

    // Create worktree using extracted worktree manager
    const worktreePath = `/tmp/e-worktrees/${branchName}`;
    await deps.worktreeManager.createWorktree(worktreePath, branchName, 'HEAD');

    // Prepare sidecar specs using extracted sidecar orchestrator
    const sidecarSpecs = (params.sidecars ?? []).map(plan => ({
      name: plan.alias,
      alias: plan.alias,
      image: plan.image,
      port: plan.port,
      healthcheck: plan.healthcheck,
      envFile: `${worktreePath}/mcp.json`,
    }));

    // Create network if needed using extracted network manager
    const network = sidecarSpecs.length > 0 && !params.runOptions.netns ? `run-network-${branch}` : undefined;
    if (network) {
      await deps.networkManager.createNetwork(network);
    }

    // Start sidecars using extracted sidecar orchestrator
    if (sidecarSpecs.length > 0) {
      await deps.sidecarOrchestrator.startAll(sidecarSpecs);

      // Wait for sidecars to be ready
      const readinessResult = await deps.sidecarOrchestrator.waitForAllReady(sidecarSpecs, {
        attempts: readinessAttempts,
        intervalMs: readinessIntervalMs,
        sleep,
      });

      if (readinessResult.notReady.length > 0) {
        return deps.runResult.failure({
          error: `MCP sidecar "${readinessResult.notReady[0].alias}" did not become ready in time`
        });
      }
    }

    // Prepare run options
    const joinedNetworks: string[] | undefined = params.runOptions.netns
      ? undefined
      : (() => {
          const nets = new Set([
            ...(params.runOptions.networks ?? []),
            ...(sidecarSpecs.length > 0 ? [network] : []),
          ]);
          return nets.size > 0 ? [...nets] : undefined;
        })();

    const runOptions: RunOptions = {
      ...params.runOptions,
      name: branchName,
      networks: joinedNetworks,
      volumes: [
        { host: worktreePath, container: '/workspace' },
        ...(params.configMounts ?? []),
      ],
      workdir: '/workspace',
    };

    // Build command using harness
    const command = params.interactive
      ? params.harness.buildInteractiveCommand(params.model)
      : params.harness.buildCommand(
          `${RUN_GIT_INSTRUCTIONS}\n\n${params.prompt}`, params.model
        );

    // Execute container using extracted container executor
    const executionResult = await deps.containerExecutor.execute(
      params.imageTag,
      runOptions,
      [...command, ...(params.mcpArgs ?? [])]
    );

    // Capture egress logs using extracted log capture
    if (params.storeRoot) {
      await deps.logCapture.captureEgressLogs(deps.runtime, params.storeRoot, branchName);
    }

    // Check sidecar status and collect warnings
    const sidecarWarnings: string[] = [];
    for (const spec of sidecarSpecs) {
      if (!await deps.sidecarOrchestrator.isSidecarReady(spec)) {
        sidecarWarnings.push(
          `MCP sidecar "${spec.alias}" exited during the run (its tools may have stopped working).`
        );
      }
    }

    // Clean up using extracted modules
    if (sidecarSpecs.length > 0) {
      await deps.sidecarOrchestrator.stopAll(sidecarSpecs);
    }
    if (network) {
      await deps.networkManager.removeNetwork(network);
    }
    await deps.worktreeManager.removeWorktree(worktreePath);

    return deps.runResult.success({
      ran: true,
      exitCode: executionResult.exitCode,
      captured: false,
      branch: branchName,
      pushed: false,
      pushWarning: undefined,
      pullRequestUrl: undefined,
      pullRequestWarning: undefined,
      sidecarWarnings,
    });

  } catch (error) {
    return deps.runResult.failure({
      error: (error as Error).message
    });
  }
}