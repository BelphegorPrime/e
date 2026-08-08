import path from 'path';
import os from 'os';
import type { Git } from './git/index';
import type { ContainerRunner, RunOptions, SidecarSpec } from './runtime/index';
import type { Harness } from './harness/index';
import type { Agent } from './agent';
import { sidecarNetworkName, sidecarContainerName } from './mcp/index';
import { slugify } from './slugify';

/** How many counter collisions to absorb before giving up (a runaway guard). */
const MAX_COUNTER_ATTEMPTS = 50;

/** Readiness polling defaults: up to 30 tries, 1s apart (~30s), overridable per run. */
const DEFAULT_READINESS_ATTEMPTS = 30;
const DEFAULT_READINESS_INTERVAL_MS = 1000;

/** How readiness polling is paced: how many probe attempts, and the wait between them. */
export interface ReadinessPolicy {
  attempts: number;
  intervalMs: number;
}

/**
 * A sidecar to bring up for this Run, as the spawn edge knows it — before the
 * per-run name exists. `runSpawn` derives the unique container name and the
 * private network from the run name and turns each plan into a {@link SidecarSpec}.
 */
export interface SidecarPlan {
  /** The MCP server's short name = network alias = URL host the agent reaches. */
  alias: string;
  /** The sidecar's image tag (built from `.e/mcp/<name>/Dockerfile`). */
  image: string;
  /** TCP port the server listens on. */
  port: number;
  /** Optional in-container readiness command; readiness also requires it to exit 0. */
  healthcheck?: string[];
  /** Env files delivering the sidecar's own credentials (never the agent's). */
  envFile?: string[];
}

/**
 * Highest run counter `N` among `branches` matching `<prefix>-N`, or 0 if none.
 * Accepts both local (`e/<harness>/<slug>-2`) and remote-tracking
 * (`origin/e/<harness>/<slug>-2`) shortnames, so the counter never reuses a
 * number already taken on origin. The next run is `max + 1`.
 */
export function maxRunCounter(branches: string[], prefix: string): number {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match `<prefix>-<N>` at the end, allowing a leading `<remote>/` segment.
  const pattern = new RegExp(`(?:^|/)${escaped}-(\\d+)$`);
  let max = 0;
  for (const branch of branches) {
    const match = pattern.exec(branch);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

/** Collaborators the orchestrator drives. Injected so tests can fake them. */
export interface RunSpawnDeps {
  git: Git;
  runtime: ContainerRunner;
  /**
   * Ensures the image this run executes is present, building it if needed, and
   * returns its tag. Called before any worktree is created so a build failure
   * never leaves orphan scaffolding. For a plain harness this is the harness
   * base image; for a file-configured agent it is the derived agent image built
   * on that base (ADR-0004). Throws on failure.
   */
  ensureImage: () => string;
  /**
   * Ensures every requested sidecar's image is present, building from
   * `.e/mcp/<name>/` as needed. Like {@link ensureImage} it runs before the
   * worktree so a sidecar build failure leaves no orphan scaffolding (ADR-0005).
   * Absent when the run requests no sidecars. Throws on failure.
   */
  ensureSidecarImages?: () => void;
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
  /**
   * A runtime-resolved model to pass on the harness command line (e.g. Codex
   * `-m <id>`), set when the agent's model was `auto`-resolved for a
   * command-configured harness. Absent for baked or env-delivered models.
   */
  model?: string;
  /** `--name` override; when set it is used as the slug verbatim. */
  name?: string;
  /**
   * The user's container run flags (env, ports, attach, rm). `volume` and
   * `workdir` are overwritten by the orchestrator to point at the run's
   * worktree, so anything set for them here is ignored.
   */
  runOptions: RunOptions;
  /** Base directory the run's worktree is created under. */
  worktreesDir?: string;
  /** Container MCP sidecars to bring up for this run (ADR-0005); empty for a plain run. */
  sidecars?: SidecarPlan[];
  /** Extra argv wiring the sidecars into the harness (e.g. Claude's `--mcp-config`). */
  mcpArgs?: string[];
  /**
   * Extra read-only mounts for the agent container (`host:container:ro` specs),
   * appended to the worktree volume — used to deliver a file harness's runtime
   * config overlay (e.g. Codex's merged `config.toml`) outside `/workspace`.
   */
  configMounts?: string[];
  /** Readiness polling overrides (mainly for tests). */
  readiness?: ReadinessPolicy;
}

export interface RunSpawnResult {
  /** True once the container ran (and returned). False for pre-run failures. */
  ran: boolean;
  /** The exit code the caller should exit the process with. */
  exitCode: number;
  /** The run's branch, when one was created. */
  branch?: string;
  /** True if the branch was pushed to origin. */
  pushed?: boolean;
  /** A non-fatal push warning: the branch is kept locally despite this. */
  pushWarning?: string;
  /** Non-fatal sidecar warnings (e.g. a sidecar that crashed mid-run). */
  sidecarWarnings?: string[];
  /** A human-readable reason for a pre-run failure (e.g. not a git repo). */
  error?: string;
}

/** True if a sidecar is ready now: its TCP port is open and any healthcheck exits 0. */
function sidecarReady(runtime: ContainerRunner, spec: SidecarSpec): boolean {
  if (!runtime.probeTcp(spec.network, spec.alias, spec.port)) return false;
  if (spec.healthcheck && !runtime.probeHealthcheck(spec.name, spec.healthcheck)) {
    return false;
  }
  return true;
}

/** Polls a sidecar for readiness up to `attempts` times, sleeping between tries. */
async function awaitSidecarReady(
  runtime: ContainerRunner,
  spec: SidecarSpec,
  opts: ReadinessPolicy & { sleep: (ms: number) => Promise<void> },
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
  params: RunSpawnParams,
): Promise<RunSpawnResult> {
  const { git, runtime, ensureImage, ensureSidecarImages } = deps;
  const { harness, agent, prompt } = params;
  const sidecarPlans = params.sidecars ?? [];
  const mcpArgs = params.mcpArgs ?? [];
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const readinessAttempts = params.readiness?.attempts ?? DEFAULT_READINESS_ATTEMPTS;
  const readinessIntervalMs =
    params.readiness?.intervalMs ?? DEFAULT_READINESS_INTERVAL_MS;

  if (!git.isRepo()) {
    return {
      ran: false,
      exitCode: 1,
      error:
        'e spawn must be run inside a git repository — every run needs an isolated worktree.',
    };
  }

  // A run's worktree is removed as soon as the container returns. Detached
  // (`--no-attach`) makes the runtime return the instant the container is
  // launched, which would tear the worktree down under a still-running agent,
  // so a run must execute in the foreground.
  if (params.runOptions.attach === false) {
    return {
      ran: false,
      exitCode: 1,
      error:
        'Detached runs (--no-attach) are not supported with per-run worktrees; run in the foreground (the default).',
    };
  }

  // Build the primary and every sidecar image before cutting any scaffolding, so
  // a build failure never leaves an orphan worktree behind (ADR-0005). The
  // returned tag is what this run executes — the harness base, or a derived agent
  // image built on it.
  const imageTag = ensureImage();
  ensureSidecarImages?.();

  // Pin the base to the commit HEAD points at now, so a later push-eligibility
  // check compares against the run's actual starting point even if the host's
  // HEAD moves while the agent works.
  const base = git.headSha();
  const slug = params.name ?? slugify(prompt);
  const prefix = `e/${agent.name}/${slug}`;
  const worktreesDir =
    params.worktreesDir ?? path.join(os.tmpdir(), 'e-worktrees');

  // Create the worktree on `<prefix>-N`, retrying at the next counter only when
  // the branch/path already exists (a concurrent spawn claimed it between our
  // enumeration and creation). Any other failure is surfaced immediately.
  let counter = maxRunCounter(git.listRunBranches(prefix), prefix) + 1;
  let branch: string;
  let runName: string;
  let worktreePath: string;
  for (let attempt = 0; ; attempt++) {
    branch = `${prefix}-${counter}`;
    runName = branch.replace(/\//g, '-');
    worktreePath = path.join(worktreesDir, runName);
    try {
      git.addWorktree({ path: worktreePath, branch, base });
      break;
    } catch (err) {
      const isCollision = /already exists/i.test((err as Error).message);
      if (!isCollision || attempt >= MAX_COUNTER_ATTEMPTS) throw err;
      counter++;
    }
  }

  // Turn each sidecar plan into a concrete spec now that the run name (and thus a
  // unique container name and the private network) exists.
  const network = sidecarNetworkName(runName);
  const specs: SidecarSpec[] = sidecarPlans.map((plan) => ({
    name: sidecarContainerName(runName, plan.alias),
    alias: plan.alias,
    image: plan.image,
    network,
    port: plan.port,
    healthcheck: plan.healthcheck,
    envFile: plan.envFile,
  }));

  let exitCode = 1;
  let ran = false;
  let readinessError: string | undefined;
  const sidecarWarnings: string[] = [];
  const startedContainers: string[] = [];
  let networkCreated = false;
  try {
    // Bring up the group: private network → sidecars → readiness. A sidecar that
    // never reaches readiness aborts the run before the agent starts (fail-fast);
    // teardown still runs in the finally.
    if (specs.length > 0) {
      runtime.createNetwork(network);
      networkCreated = true;
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
      const runOptions: RunOptions = {
        ...params.runOptions,
        name: runName,
        // The worktree is always mounted at /workspace; a file harness's config
        // overlay (if any) is appended as extra read-only mounts outside it.
        volume: [`${worktreePath}:/workspace`, ...(params.configMounts ?? [])],
        workdir: '/workspace',
        // The agent joins the run's private network only when it has sidecars to
        // reach; a plain run stays on the default bridge, unchanged.
        network: specs.length > 0 ? network : undefined,
      };
      exitCode = await runtime.run(imageTag, runOptions, [
        ...harness.buildCommand(prompt, params.model),
        ...mcpArgs,
      ]);
      ran = true;

      // A sidecar that crashed mid-run is non-fatal (like a failed push): the
      // agent may hold uncommitted work, so surface a warning, never kill it.
      for (const spec of specs) {
        if (!runtime.isRunning(spec.name)) {
          sidecarWarnings.push(
            `MCP sidecar "${spec.alias}" exited during the run (its tools may have stopped working).`,
          );
        }
      }

      // Capture whatever the agent left uncommitted; a clean tree keeps the
      // agent's own commits untouched.
      if (git.isDirty(worktreePath)) {
        git.commitAll(worktreePath, `e: capture run output for ${branch}`);
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
    if (networkCreated) bestEffort(() => runtime.removeNetwork(network));
    git.removeWorktree(worktreePath);
  }

  const warnings = sidecarWarnings.length > 0 ? sidecarWarnings : undefined;

  // A readiness miss aborts the run before the agent started: no commit, no push.
  if (readinessError) {
    return { ran: false, exitCode: 1, branch, error: readinessError, sidecarWarnings: warnings };
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

  return { ran, exitCode, branch, pushed, pushWarning, sidecarWarnings: warnings };
}
