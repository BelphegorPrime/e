import os from 'node:os';
import path from 'node:path';
import { Env } from '../utils/env.js';

/**
 * Where a Run's git worktree is created on the host. The directory has to
 * satisfy two masters: git (any writable path) and the container engine,
 * which bind-mounts the worktree at `/workspace`. On Linux the engine runs on
 * the host kernel and any path mounts, so worktrees go to the temp dir. On
 * macOS and Windows every engine runs inside a VM (Docker Desktop, OrbStack,
 * Colima, Rancher Desktop, Podman machine, WSL 2) and shares only some host
 * paths into it - the user's home directory is the one path all of them
 * share by default, while the system temp dir (`/var/folders/...` on macOS)
 * is not mounted by Colima or Podman machine. So those platforms default to
 * a cache dir under the user's profile. `E_WORKTREES_DIR` overrides the
 * default everywhere, for engines configured with custom shares.
 */
export interface WorktreesDirInput {
  /** `process.platform`. */
  platform: string;
  /** `os.homedir()`. */
  homedir: string;
  /** `os.tmpdir()`. */
  tmpdir: string;
  /** The process environment (`E_WORKTREES_DIR`, `LOCALAPPDATA`). */
  environment: Record<string, string | undefined>;
}

/** Resolves the worktrees directory, purely (see the module doc for the rules). */
export function resolveWorktreesDir(input: WorktreesDirInput): string {
  const override = input.environment[Env.WORKTREES_DIR_VAR]?.trim();
  if (override) return path.resolve(override);
  switch (input.platform) {
    case 'darwin':
      return path.join(input.homedir, 'Library', 'Caches', 'e', 'worktrees');
    case 'win32': {
      const localAppData =
        input.environment.LOCALAPPDATA?.trim() ||
        path.join(input.homedir, 'AppData', 'Local');
      return path.join(localAppData, 'e', 'worktrees');
    }
    default:
      return path.join(input.tmpdir, 'e-worktrees');
  }
}

/** The worktrees directory for this process (see {@link resolveWorktreesDir}). */
export function defaultWorktreesDir(): string {
  return resolveWorktreesDir({
    platform: process.platform,
    homedir: os.homedir(),
    tmpdir: os.tmpdir(),
    environment: process.env,
  });
}

/**
 * The host path of the worktree for run `branch` (`e/<agent>/<slug>-N`) under
 * `worktreesDir`. The branch's `/` segments become nested directories with
 * the platform's separator, so the path is valid for git and for the engine's
 * `-v host:container` on Windows too.
 */
export function worktreePathFor(worktreesDir: string, branch: string): string {
  return path.join(worktreesDir, ...branch.split('/'));
}
