import path from 'path';
import os from 'os';
import type { Git } from './git/index';
import type { ContainerRunner, RunOptions } from './runtime/index';
import type { Harness } from './harness/index';
import { slugify } from './slugify';

/** Collaborators the orchestrator drives. Injected so tests can fake them. */
export interface RunSpawnDeps {
  git: Git;
  runtime: ContainerRunner;
  /**
   * Builds the harness image if it isn't already present. Called before any
   * worktree is created so a build failure never leaves orphan scaffolding.
   * Throws on failure.
   */
  ensureImage: () => void;
}

export interface RunSpawnParams {
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
  /** A human-readable reason for a pre-run failure (e.g. not a git repo). */
  error?: string;
}

/**
 * Drives one Run's lifecycle: require a git repo, build the image if needed,
 * cut an isolated worktree on a fresh branch from `HEAD`, run the harness
 * against it, capture any leftover uncommitted changes, then remove the
 * worktree (keeping the branch). All git stays in this host process.
 *
 * Slice #2: no run counter and no origin push — those extend this in later
 * slices. The branch is `e/<harness>/<slug>`.
 */
export async function runSpawn(
  deps: RunSpawnDeps,
  params: RunSpawnParams,
): Promise<RunSpawnResult> {
  const { git, runtime, ensureImage } = deps;
  const { harness, prompt } = params;

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
  // leaves an orphan worktree behind.
  ensureImage();

  const slug = params.name ?? slugify(prompt);
  const branch = `e/${harness.name}/${slug}`;
  const runName = `e-${harness.name}-${slug}`;
  const worktreesDir =
    params.worktreesDir ?? path.join(os.tmpdir(), 'e-worktrees');
  const worktreePath = path.join(worktreesDir, runName);

  git.addWorktree({ path: worktreePath, branch, base: 'HEAD' });

  let exitCode: number;
  try {
    const runOptions: RunOptions = {
      ...params.runOptions,
      name: runName,
      volume: [`${worktreePath}:/workspace`],
      workdir: '/workspace',
    };
    exitCode = await runtime.run(
      harness.imageTag,
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

  return { ran: true, exitCode, branch };
}
