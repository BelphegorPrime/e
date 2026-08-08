import path from 'path';
import os from 'os';
import type { Git } from './git/index';
import type { ContainerRunner, RunOptions } from './runtime/index';
import type { Harness } from './harness/index';
import type { Agent } from './agent';
import { slugify } from './slugify';

/** How many counter collisions to absorb before giving up (a runaway guard). */
const MAX_COUNTER_ATTEMPTS = 50;

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
}

export interface RunSpawnParams {
  /** The resolved Agent this run executes; its name is the run's branch segment. */
  agent: Agent;
  /** The Harness the agent runs (its image and invocation). */
  harness: Harness;
  /** The prompt, already joined into a single string. */
  prompt: string;
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
  /** A human-readable reason for a pre-run failure (e.g. not a git repo). */
  error?: string;
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
  const { git, runtime, ensureImage } = deps;
  const { harness, agent, prompt } = params;

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

  // Build the image before cutting any scaffolding, so a build failure never
  // leaves an orphan worktree behind. The returned tag is what this run
  // executes — the harness base, or a derived agent image built on it.
  const imageTag = ensureImage();

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

  let exitCode: number;
  try {
    const runOptions: RunOptions = {
      ...params.runOptions,
      name: runName,
      volume: [`${worktreePath}:/workspace`],
      workdir: '/workspace',
    };
    exitCode = await runtime.run(
      imageTag,
      runOptions,
      harness.buildCommand(prompt),
    );

    // Capture whatever the agent left uncommitted; a clean tree keeps the
    // agent's own commits untouched.
    if (git.isDirty(worktreePath)) {
      git.commitAll(worktreePath, `e: capture run output for ${branch}`);
    }
  } finally {
    // The worktree is disposable scaffolding; the branch is the durable
    // artifact. Always drop the worktree, always keep the branch.
    git.removeWorktree(worktreePath);
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

  return { ran: true, exitCode, branch, pushed, pushWarning };
}
