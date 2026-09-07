import path from 'path';
import os from 'os';
import fs from 'fs';
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
import {
  runName,
  runBranchPrefix,
  maxRunCounter,
  type RunName,
} from '../identity/naming.js';
import { slugify } from '../identity/slugify.js';

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
  /** Env files delivering the sidecar's own credentials (never the agent's). */
  envFile?: string[];
}

/** Collaborators the orchestrator drives. Injected so tests can fake them. */
export interface RunSpawnDeps {
  git: Git;
  runtime: ContainerRunner;
  /** Optional PR/MR opener (present only when the store has a platform). */
  pullRequest?: PullRequest;
  /** Sleep between readiness probes; injected so tests poll without real waits. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunSpawnParams {
  /** The resolved Agent this run executes; its name is the run's branch segment. */
  agent: Agent;
  /** The Harness the agent runs (its image and invocation). */
  harness: Harness;
  /** The prompt, already joined into a single string. */
  prompt: string;
  /** Start the harness TUI instead of sending the prompt as a one-shot command. */
  interactive?: boolean;
  /**
   * The image this run executes, already built by the executor before the run
   * (ADR-0005/0008): the harness base, or a derived agent image built on it.
   */
  imageTag: string;
  /**
   * A runtime-resolved model to pass on the harness command line (e.g. Codex
   * `-m <id>`), set when the agent's model was `auto`-resolved for a
   * command-configured harness. Absent for baked or env-delivered models.
   */
  model?: string;
  /** `--name` override; when set it is used as the slug verbatim. */
  name?: string;
  /**
   * The user's container run flags (env, ports, attach, rm). `volumes` and
   * `workdir` are overwritten by the orchestrator to point at the run's
   * worktree, so anything set for them here is ignored.
   */
  runOptions: RunOptions;
  /** Base directory the run's worktree is created under. */
  worktreesDir?: string;
  /** The global Compose egress container (`e-egress`). */
  egress?: string;
  /** Container MCP sidecars to bring up for this run (ADR-0005); empty for a plain run. */
  sidecars?: SidecarPlan[];
  /** Extra argv wiring the sidecars into the harness (e.g. Claude's `--mcp-config`). */
  mcpArgs?: string[];
  /**
   * Extra read-only mounts for the agent container, appended to the worktree
   * volumes — used to deliver a file harness's runtime config overlay (e.g.
   * Codex's merged `config.toml`) and per-run skills outside `/workspace`.
   */
  configMounts?: Mount[];
  /** Readiness polling overrides (mainly for tests). */
  readiness?: ReadinessPolicy;
  /** The configured git platform (`github` | `gitlab` | ... ) for PR/MR; absent disables. */
  gitPlatform?: GitPlatform;
  /** The store root path; when present, egress logs are written per-run. */
  storeRoot?: string;
}

export interface RunSpawnResult {
  /** True once the container ran (and returned). False for pre-run failures. */
  ran: boolean;
  /** The exit code the caller should exit the process with. */
  exitCode: number;
  /** True when the host committed uncommitted changes left by the harness. */
  captured?: boolean;
  /** The run's branch, when one was created. */
  branch?: string;
  /** True if the branch was pushed to origin. */
  pushed?: boolean;
  /** A non-fatal push warning: the branch is kept locally despite this. */
  pushWarning?: string;
  /** The PR/MR web URL, when one was created and the platform succeeded. */
  pullRequestUrl?: string;
  /** A non-fatal PR/MR warning: the push succeeded but the PR/MR did not open. */
  pullRequestWarning?: string;
  /** Non-fatal sidecar warnings (e.g. a sidecar that crashed mid-run). */
  sidecarWarnings?: string[];
  /** A human-readable reason for a pre-run failure (e.g. not a git repo). */
  error?: string;
}

/** True if a sidecar is ready now: its TCP port is open and any healthcheck exits 0. */
function sidecarReady(runtime: ContainerRunner, spec: SidecarSpec): boolean {
  // In egress/netns mode all containers share a network namespace, so
  // localhost reaches the sidecar. On a private Docker network the probe
  // container must address the sidecar by its network alias.
  const host = spec.netns ? 'localhost' : spec.alias;
  if (!runtime.probeTcp(spec.netns ?? spec.network!, host, spec.port)) return false;
  if (
    spec.healthcheck &&
    !runtime.probeHealthcheck(spec.name, spec.healthcheck)
  ) {
    return false;
  }
  return true;
}

/** Polls a sidecar for readiness up to `attempts` times, sleeping between tries. */
async function awaitSidecarReady(
  runtime: ContainerRunner,
  spec: SidecarSpec,
  opts: ReadinessPolicy & { sleep: (ms: number) => Promise<void> }
): Promise<boolean> {
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    if (sidecarReady(runtime, spec)) return true;
    if (attempt < opts.attempts - 1) await opts.sleep(opts.intervalMs);
  }
  return false;
}

/** Runs a best-effort teardown step, swallowing any failure so it can't mask the run's result. */
function bestEffort(action: () => void): void {
  try {
    action();
  } catch {
    // Teardown failures are non-fatal by design (ADR-0005).
  }
}

/**
 * Drives one Run's lifecycle: require a git repo, build the image if needed,
 * cut an isolated worktree on a fresh branch from `HEAD`, run the harness
 * against it, capture any leftover uncommitted changes, remove the worktree
 * (keeping the branch), and push a successful run's branch to origin. All git
 * stays in this host process, so push credentials never enter the container.
 *
 * The branch is `e/<agent>/<slug>-N`, where `N` is the next counter after
 * the existing run branches for this slug; a create collision (a concurrent
 * spawn took the number first) bumps `N` and retries.
 */
export async function runSpawn(
  deps: RunSpawnDeps,
  params: RunSpawnParams
): Promise<RunSpawnResult> {
  const { git, runtime } = deps;
  const { harness, agent, prompt, imageTag } = params;
  const sidecarPlans = params.sidecars ?? [];
  const mcpArgs = params.mcpArgs ?? [];
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const readinessAttempts =
    params.readiness?.attempts ?? DEFAULT_READINESS_ATTEMPTS;
  const readinessIntervalMs =
    params.readiness?.intervalMs ?? DEFAULT_READINESS_INTERVAL_MS;

  // The executor has already run the preflight guards (a git repo, foreground)
  // and built the primary and sidecar images before calling us (ADR-0008), so a
  // build failure never leaves an orphan worktree behind (ADR-0005). We own the
  // worktree lifecycle from here.

  // Pin the base to the commit HEAD points at now, so a later push-eligibility
  // check compares against the run's actual starting point even if the host's
  // HEAD moves while the agent works. The branch name is the PR/MR target —
  // the branch the user was on when they spawned.
  const base = git.headSha();
  const baseBranch = git.currentBranch() || 'main';
  const slug = params.name ?? slugify(prompt);
  const prefix = runBranchPrefix(agent.name, slug);
  const worktreesDir =
    params.worktreesDir ?? path.join(os.tmpdir(), 'e-worktrees');

  // Create the worktree on `<prefix>-N`, retrying at the next counter only when
  // the branch/path already exists (a concurrent spawn claimed it between our
  // enumeration and creation). Any other failure is surfaced immediately.
  let counter = maxRunCounter(git.listRunBranches(prefix), prefix) + 1;
  let run: RunName;
  let worktreePath: string;
  for (let attempt = 0; ; attempt++) {
    run = runName(agent.name, slug, counter);
    worktreePath = path.join(worktreesDir, run.name);
    try {
      git.addWorktree({ path: worktreePath, branch: run.branch, base });
      break;
    } catch (err) {
      const isCollision = /already exists/i.test((err as Error).message);
      if (!isCollision || attempt >= MAX_COUNTER_ATTEMPTS) throw err;
      counter++;
    }
  }
  const branch = run.branch;

  // Turn each sidecar plan into a concrete spec now that the run name (and thus a
  // unique container name and the private network) exists.
  const network = run.network;
  const egress = params.egress;
  const specs: SidecarSpec[] = sidecarPlans.map(plan => ({
    name: run.sidecarContainer(plan.alias),
    alias: plan.alias,
    image: plan.image,
    netns: params.runOptions.netns,
    network: params.runOptions.netns ? undefined : network,
    port: plan.port,
    healthcheck: plan.healthcheck,
    envFile: plan.envFile,
  }));

  let exitCode = 1;
  let ran = false;
  let captured = false;
  let readinessError: string | undefined;
  const sidecarWarnings: string[] = [];
  const startedContainers: string[] = [];
  let networkCreated = false;
  try {
    // Bring up the group (ADR-0005): private network (when the run has sidecars
    // and no shared egress netns) → sidecars → readiness. A sidecar that never
    // reaches readiness aborts the run before the agent starts (fail-fast);
    // teardown still runs in the finally. When netns is set (egress mode), all
    // containers share e-egress network namespace; skip private network creation.
    if (specs.length > 0 && !params.runOptions.netns) {
      runtime.createNetwork(network);
      networkCreated = true;
    }
    if (specs.length > 0) {
      for (const spec of specs) {
        runtime.startSidecar(spec);
        startedContainers.push(spec.name);
      }
      for (const spec of specs) {
        const ready = await awaitSidecarReady(runtime, spec, {
          attempts: readinessAttempts,
          intervalMs: readinessIntervalMs,
          sleep,
        });
        if (!ready) {
          readinessError =
            `MCP sidecar "${spec.alias}" did not become ready in time; ` +
            `aborting before the agent started. Check its image and mcp.json.`;
          break;
        }
      }
    }

    if (!readinessError) {
      // Agent joins its run's private network when sidecars exist. Its normal
      // Docker network remains unchanged for runs without sidecars.
      const runOptions: RunOptions = {
        ...params.runOptions,
        name: run.name,
        networks: params.runOptions.netns
          ? undefined
          : (() => {
              const nets = [
                ...new Set([
                  ...(params.runOptions.networks ?? []),
                  ...(specs.length > 0 ? [network] : []),
                ]),
              ];
              return nets.length > 0 ? nets : undefined;
            })(),
        // The worktree is always mounted at /workspace; a file harness's config
        // overlay (if any) is appended as extra read-only mounts outside it.
        volumes: [
          { host: worktreePath, container: '/workspace' },
          ...(params.configMounts ?? []),
        ],
        workdir: '/workspace',
      };
      const command = params.interactive
        ? harness.buildInteractiveCommand(params.model)
        : harness.buildCommand(
            `${RUN_GIT_INSTRUCTIONS}\n\n${prompt}`,
            params.model
          );
      exitCode = await runtime.run(imageTag, runOptions, [
        ...command,
        ...mcpArgs,
      ]);
      ran = true;

      // Capture egress logs per-run when store root is present.
      if (params.storeRoot) {
        const egressLogs = runtime.containerLogs('egress');
        if (egressLogs !== undefined) {
          const logDir = path.join(params.storeRoot, '.e', 'egress-logs');
          fs.mkdirSync(logDir, { recursive: true });
          const logFile = path.join(logDir, `e-${run.name}.log`);
          fs.writeFileSync(logFile, egressLogs, 'utf8');
        }
      }

      // A sidecar that crashed mid-run is non-fatal (like a failed push): the
      // agent may hold uncommitted work, so surface a warning, never kill it.
      for (const spec of specs) {
        if (!runtime.isRunning(spec.name)) {
          sidecarWarnings.push(
            `MCP sidecar "${spec.alias}" exited during the run (its tools may have stopped working).`
          );
        }
      }

      // Capture whatever the agent left uncommitted; a clean tree keeps the
      // agent's own commits untouched.
      if (git.isDirty(worktreePath)) {
        git.commitAll(worktreePath, `e: capture run output for ${branch}`);
        captured = true;
      }
    }
  } finally {
    // Tear the group down as a group (ADR-0005): agent (already gone by --rm on
    // exit) → sidecars → network → worktree. Sidecar/network removal is
    // best-effort so a teardown failure never masks the run's result; the
    // worktree is disposable scaffolding while the branch is the durable artifact.
    for (const name of startedContainers) {
      bestEffort(() => runtime.removeContainer(name));
    }
    if (networkCreated) {
      bestEffort(() => runtime.removeNetwork(network));
    }

    if (params.runOptions.rmWorktree === true) {
      git.removeWorktree(worktreePath);
    }
  }

  const warnings = sidecarWarnings.length > 0 ? sidecarWarnings : undefined;

  // A readiness miss aborts the run before the agent started: no commit, no push.
  if (readinessError) {
    return {
      ran: false,
      exitCode: 1,
      branch,
      error: readinessError,
      sidecarWarnings: warnings,
    };
  }

  // Publish only a successful run that actually produced commits, so aborted
  // or no-op runs never litter origin. A push failure is non-fatal: the
  // branch is kept locally and the reason surfaced as a warning.
  let pushed = false;
  let pushWarning: string | undefined;
  if (exitCode === 0 && git.hasCommitsBeyondBase(branch, base)) {
    try {
      git.push(branch);
      pushed = true;
    } catch (err) {
      pushWarning = `could not push ${branch} to origin (kept locally): ${(err as Error).message}`;
    }
  }

  // When the store has a git platform and the run pushed, open a PR/MR into
  // the branch the user was on when they spawned (the run's natural target).
  // The title is the branch's tip commit subject (the run's commit message);
  // the body is the prompt that drove the run. Non-fatal: a missing CLI, an
  // unauthenticated session, or a platform rejection only warn — the pushed
  // branch remains the durable artifact.
  let pullRequestUrl: string | undefined;
  let pullRequestWarning: string | undefined;
  if (pushed && params.gitPlatform && deps.pullRequest) {
    const title =
      git.runLog(branch).find(c => c.subject.trim().length > 0)?.subject ||
      `e: run output for ${branch}`;
    try {
      pullRequestUrl = deps.pullRequest.create({
        platform: params.gitPlatform,
        head: branch,
        base: baseBranch,
        title,
        body: prompt,
      });
    } catch (err) {
      pullRequestWarning = `could not open a ${params.gitPlatform} merge request for ${branch}: ${(err as Error).message}`;
    }
  }

  return {
    ran,
    exitCode,
    captured,
    branch,
    pushed,
    pushWarning,
    pullRequestUrl,
    pullRequestWarning,
    sidecarWarnings: warnings,
  };
}
