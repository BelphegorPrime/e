import type { Git } from './git/index.js';
import type { PullRequest } from '../github/index.js';
import type { GitPlatform } from '../store/config.js';
import type { ContainerRunner, RunOptions, SidecarSpec, Mount } from './runtime/index.js';
import type { Harness } from '../harness/index.js';
import type { Agent } from '../agent/index.js';
import { RunBranchNamer } from './runBranchNamer.js';
import { WorktreeManager, ProductionWorktreeManager } from './runWorktree.js';
import { NetworkManager, ProductionNetworkManager } from './runNetworks.js';
import { SidecarOrchestrator, DockerSidecarOrchestrator } from './runSidecarOrchestrator.js';
import { ContainerExecutor, ProductionContainerExecutor } from './runContainerExecution.js';
import { PullRequestManager, ProductionPullRequestManager } from './runPrManager.js';
import { LogCapture, ProductionLogCapture } from './runLogCapture.js';
import { RunResult, ProductionRunResult } from './runResult.js';

/** Clean seam for run orchestration. */
export interface RunOrchestrator {
  /** Execute a run with all its dependencies. */
  executeRun(
    deps: RunSpawnDeps,
    params: RunSpawnParams
  ): Promise<RunSpawnResult>;
}

/** Production run orchestrator using actual implementations. */
export class ProductionRunOrchestrator implements RunOrchestrator {
  constructor(
    private readonly git: Git,
    private readonly pullRequest: PullRequest,
    private readonly runtime: ContainerRunner
  ) {}

  async executeRun(
    deps: RunSpawnDeps,
    params: RunSpawnParams
  ): Promise<RunSpawnResult> {
    // Initialize managers
    const networkManager = new ProductionNetworkManager(this.runtime);
    const worktreeManager = new ProductionWorktreeManager(this.git);
    const sidecarOrchestrator = new DockerSidecarOrchestrator(this.runtime);
    const containerExecutor = new ProductionContainerExecutor(this.runtime);
    const pullRequestManager = new ProductionPullRequestManager(this.git, this.pullRequest);
    const logCapture = new ProductionLogCapture();
    const runResult = new ProductionRunResult();

    return this.runWithDependencies(
      deps,
      params,
      worktreeManager,
      networkManager,
      sidecarOrchestrator,
      containerExecutor,
      pullRequestManager,
      logCapture,
      runResult
    );
  }

  private async runWithDependencies(
    deps: RunSpawnDeps,
    params: RunSpawnParams,
    worktreeManager: WorktreeManager,
    networkManager: NetworkManager,
    sidecarOrchestrator: SidecarOrchestrator,
    containerExecutor: ContainerExecutor,
    pullRequestManager: PullRequestManager,
    logCapture: LogCapture,
    runResult: RunResult
  ): Promise<RunSpawnResult> {
    const {
      sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms)),
    } = deps;

    const readinessAttempts = params.readiness?.attempts ?? 30;
    const readinessIntervalMs = params.readiness?.intervalMs ?? 1000;

    try {
      // Pin the base to the commit HEAD points at now
      const base = this.git.headSha();
      const baseBranch = await this.git.currentBranch() || 'main';
      const slug = params.name ?? slugify(params.prompt);
      const prefix = `e/${params.agent.name}/${slug}`;
      const worktreesDir = params.worktreesDir ?? `/tmp/e-worktrees`;

      // Generate next branch name
      const branchNamer = new RunBranchNamer(this.git);
      const { branch, counter } = await branchNamer.nextBranch(params.agent, params.prompt);
      const worktreePath = `${worktreesDir}/${branch}`;

      // Create worktree
      await worktreeManager.createWorktree(worktreePath, branch, base);

      // Prepare sidecars
      const sidecarPlans = params.sidecars ?? [];
      const specs = sidecarPlans.map(plan => ({
        name: plan.alias,
        alias: plan.alias,
        image: plan.image,
        port: plan.port,
        healthcheck: plan.healthcheck,
        envFile: `${worktreePath}/mcp.json`,
      })) as SidecarSpec[];

      // Create network if needed
      const network = specs.length > 0 && !params.runOptions.netns ? `run-network-${branch}` : undefined;
      if (network) {
        await networkManager.createNetwork(network);
      }

      // Start sidecars
      if (specs.length > 0) {
        await sidecarOrchestrator.startAll(specs);

        // Wait for sidecars to be ready
        const readinessResult = await sidecarOrchestrator.waitForAllReady(specs, {
          attempts: readinessAttempts,
          intervalMs: readinessIntervalMs,
          sleep,
        });

        if (readinessResult.notReady.length > 0) {
          return runResult.failure({
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
              ...(specs.length > 0 ? [network] : []),
            ]);
            return nets.size > 0 ? [...nets] : undefined;
          })();

      const runOptions: RunOptions = {
        ...params.runOptions,
        name: branch,
        networks: joinedNetworks,
        volumes: [
          { host: worktreePath, container: '/workspace' },
          ...(params.configMounts ?? []),
        ],
        workdir: '/workspace',
      };

      // Build command
      const command = params.interactive
        ? params.harness.buildInteractiveCommand(params.model)
        : params.harness.buildCommand(
            `${RUN_GIT_INSTRUCTIONS}\n\n${params.prompt}`, params.model
          );

      // Execute container
      const executionResult = await containerExecutor.execute(
        params.imageTag,
        runOptions,
        [...command, ...(params.mcpArgs ?? [])]
      );

      // Capture egress logs
      if (params.storeRoot) {
        await logCapture.captureEgressLogs(this.runtime, params.storeRoot, branch);
      }

      // Check sidecar status
      const sidecarWarnings: string[] = [];
      for (const spec of specs) {
        if (!await this.runtime.isSidecarReady(spec.name)) {
          sidecarWarnings.push(
            `MCP sidecar "${spec.alias}" exited during the run (its tools may have stopped working).`
          );
        }
      }

      // Clean up
      await sidecarOrchestrator.stopAll(specs);
      if (network) {
        await networkManager.removeNetwork(network);
      }
      await worktreeManager.removeWorktree(worktreePath);

      return runResult.success({
        ran: true,
        exitCode: executionResult.exitCode,
        captured: false, // Would need to check git status
        branch,
        pushed: false, // Would need to push logic
        pushWarning: undefined,
        pullRequestUrl: undefined,
        pullRequestWarning: undefined,
        sidecarWarnings,
      });

    } catch (error) {
      return runResult.failure({
        error: (error as Error).message
      });
    }
  }
}

/** In-memory run orchestrator for testing. */
export class InMemoryRunOrchestrator implements RunOrchestrator {
  async executeRun(
    deps: RunSpawnDeps,
    params: RunSpawnParams
  ): Promise<RunSpawnResult> {
    // Simple in-memory implementation for testing
    return {
      ran: false,
      exitCode: 1,
      error: 'In-memory orchestrator not implemented',
      sidecarWarnings: [],
    };
  }
}