/**
 * **Artifact sync** (ADR-0013, ticket 05): a sibling's worktree is cut from a
 * commit, so it holds none of the parent's gitignored build artifacts
 * (`node_modules`, ...). Before the sibling's container starts, the host
 * copies an allowlist of them from the parent worktree into a scratch
 * directory and bind-mounts each at the same `/workspace/<entry>` path inside
 * the sibling's container - the copy never enters the sibling's worktree, so
 * it can never land in its branch whatever the repo ignores. The sibling is
 * free to regenerate its own (`npm install` over the mount works), which is
 * also why a failed copy degrades to "no artifact" instead of failing the run.
 *
 * The copy is a reflink where the filesystem supports it (btrfs, xfs, APFS:
 * instant, copy-on-write) and a plain copy otherwise - Node's
 * `COPYFILE_FICLONE` makes that decision per file, portably. Secrets and git
 * metadata are never copied, whatever the allowlist says (ADR-0002). And the
 * parent worktree is written by an unsupervised agent, so only real paths
 * inside it are synced: a symlinked entry (or a symlink on the way to it) could
 * otherwise hand the sibling any host directory through the bind mount.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Mount } from '../runtime/index.js';

import { errorMessage } from '../utils/errors.js';
/**
 * Names that are never synced, as an allowlist entry or inside a copied tree:
 * git metadata and env files (`.env`, `.env.local`, ...), the ADR-0002 line.
 */
export function isNeverSynced(name: string): boolean {
  return name === '.git' || name === '.env' || name.startsWith('.env.');
}

/**
 * Filters an allowlist down to the relative paths that may be synced, purely:
 * normalized (`./`, trailing `/`, backslashes), de-duplicated, and dropped when
 * absolute, escaping upwards, or naming a never-synced segment anywhere.
 */
export function planArtifactSync(entries: readonly string[]): string[] {
  const allowed = new Set<string>();
  for (const raw of entries) {
    const entry = raw
      .trim()
      .replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/\/+$/, '');
    if (entry === '' || entry === '.' || path.posix.isAbsolute(entry)) continue;
    const segments = entry.split('/');
    if (segments.some(s => s === '' || s === '..' || isNeverSynced(s))) {
      continue;
    }
    allowed.add(entry);
  }
  return [...allowed];
}

/**
 * Where run `runName` keeps its synced artifacts: under the worktrees dir, the
 * one host path every container engine is known to bind-mount (see
 * `worktreesDir.ts`), apart from the worktrees themselves.
 */
export function artifactsDirFor(worktreesDir: string, runName: string): string {
  return path.join(worktreesDir, '.artifacts', runName);
}

/**
 * Copies one artifact tree: recursive, reflink where the filesystem can and a
 * plain copy otherwise (`COPYFILE_FICLONE`), symlinks kept verbatim so the
 * relative links in `node_modules/.bin` still resolve inside the container
 * (an absolute one pointing at the host dangles there, as it does in the
 * parent's container), and every never-synced name skipped inside the tree.
 */
export function copyArtifact(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    mode: fs.constants.COPYFILE_FICLONE,
    filter: source => !isNeverSynced(path.basename(source)),
  });
}

/** What {@link syncArtifacts} works from. */
export interface ArtifactSyncOptions {
  /** The parent run's worktree on the host. */
  parentWorktree: string;
  /** The sibling's scratch directory the copies go under. */
  targetDir: string;
  /** The allowlist (relative paths under the worktree), filtered by {@link planArtifactSync}. */
  entries: readonly string[];
  /** Where the worktree is mounted in the container (default `/workspace`). */
  workspace?: string;
}

/** What {@link syncArtifacts} did, entry by entry; only `mounts` drives the run. */
export interface ArtifactSyncResult {
  /** Entries found in the parent and copied. */
  copied: string[];
  /** Allowed entries the parent worktree does not have (nothing to sync). */
  missing: string[];
  /** Entries that are not a real file or directory inside the worktree (a symlink somewhere on the way). */
  refused: string[];
  /** Entries whose copy failed (disk full, permissions); nothing of them is mounted. */
  failed: { entry: string; error: string }[];
  /** One bind mount per copied entry, at the same path inside the container. */
  mounts: Mount[];
}

/**
 * Classifies one allowed entry: the real path to copy, or why not. Real means
 * the entry itself is a directory or file (not a symlink) and no segment on
 * the way to it is a symlink either - `realpath` must land exactly where the
 * segments say, inside the worktree.
 */
function locate(
  parentWorktree: string,
  segments: string[]
): { src: string } | 'missing' | 'refused' {
  const src = path.join(parentWorktree, ...segments);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(src);
  } catch {
    return 'missing';
  }
  if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) {
    return 'refused';
  }
  let root: string;
  try {
    root = fs.realpathSync(parentWorktree);
  } catch {
    return 'missing';
  }
  return fs.realpathSync(src) === path.join(root, ...segments)
    ? { src }
    : 'refused';
}

/** Copies the allowed entries that exist in the parent and returns their mounts. */
export function syncArtifacts(opts: ArtifactSyncOptions): ArtifactSyncResult {
  const workspace = opts.workspace ?? '/workspace';
  const result: ArtifactSyncResult = {
    copied: [],
    missing: [],
    refused: [],
    failed: [],
    mounts: [],
  };
  for (const entry of planArtifactSync(opts.entries)) {
    const segments = entry.split('/');
    const located = locate(opts.parentWorktree, segments);
    if (located === 'missing' || located === 'refused') {
      result[located].push(entry);
      continue;
    }
    const dest = path.join(opts.targetDir, ...segments);
    try {
      copyArtifact(located.src, dest);
    } catch (err) {
      // A half-copied tree would be worse than none: the sibling regenerates.
      fs.rmSync(dest, { recursive: true, force: true });
      result.failed.push({ entry, error: errorMessage(err) });
      continue;
    }
    result.copied.push(entry);
    result.mounts.push({
      host: dest,
      container: path.posix.join(workspace, entry),
    });
  }
  return result;
}

/** Best-effort removal of a run's synced artifacts at teardown. */
export function removeArtifacts(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
