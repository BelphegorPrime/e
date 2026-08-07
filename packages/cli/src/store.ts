import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The **Store**: the `.e` directory holding e's on-disk state — the per-harness
 * Dockerfiles under `harnesses/` and the shared `.env` base environment. This
 * module owns the store's layout (path derivation keyed on a harness *name*)
 * and the root-finding walk that locates it. It knows nothing about the Harness
 * registry, so the dependency runs one way: `harness` → `store`.
 */

/**
 * The `.e` directory under `root` that holds all of e's state (harness
 * Dockerfiles, the shared `.env`, ...).
 * `root` defaults to the user's home directory; `e init --dir <path>` uses
 * `<path>` as the root instead (e.g. to init into the current project).
 */
export function eBaseDir(root: string = os.homedir()): string {
  return path.join(root, '.e');
}

/** Base directory that holds the harness Dockerfiles, under `root`. */
export function harnessesBaseDir(root?: string): string {
  return path.join(eBaseDir(root), 'harnesses');
}

/**
 * Path to the shared `.env` file loaded as the base environment for every
 * harness container. Lives alongside the `harnesses/` dir under `.e`.
 */
export function envFilePath(root?: string): string {
  return path.join(eBaseDir(root), '.env');
}

/** Directory containing a single harness's Dockerfile. */
export function harnessDir(name: string, root?: string): string {
  return path.join(harnessesBaseDir(root), name);
}

/** Absolute path to a harness's Dockerfile. */
export function dockerfilePath(name: string, root?: string): string {
  return path.join(harnessDir(name, root), 'Dockerfile');
}

/** Returns true if `e init` has written this harness's Dockerfile under `root`. */
export function isInitialized(name: string, root?: string): boolean {
  return fs.existsSync(dockerfilePath(name, root));
}

/** Inputs to the pure root resolution; the glue supplies the real values. */
export interface ResolveRootInput {
  /** `--dir <path>` value, if the user passed one. */
  explicitDir: string | undefined;
  /** The directory the walk-up starts from (normally `process.cwd()`). */
  cwd: string;
  /** The user's home directory, tried last. */
  homedir: string;
  /** Predicate: does this candidate directory contain a `.e` store? */
  hasStore: (dir: string) => boolean;
}

/**
 * Resolves the root directory that holds the `.e` store, purely.
 *
 * Resolution order:
 *  1. `explicitDir` (from `--dir`), resolved to an absolute path.
 *  2. The nearest ancestor of `cwd` (walking up to the filesystem root) that
 *     contains a `.e` store.
 *  3. The home directory, if it contains a `.e` store.
 *
 * Returns `undefined` if none of the candidates contain a store.
 */
export function resolveRoot({
  explicitDir,
  cwd,
  homedir,
  hasStore,
}: ResolveRootInput): string | undefined {
  if (explicitDir) return path.resolve(explicitDir);

  let dir = cwd;
  while (true) {
    if (hasStore(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }

  if (hasStore(homedir)) return homedir;

  return undefined;
}

/** True if `p` exists and is a directory. */
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Locates the store root against the real filesystem: wires `process.cwd()`,
 * `os.homedir()`, and a `statSync`-based `hasStore` predicate into the pure
 * {@link resolveRoot}.
 */
export function findRoot(explicitDir?: string): string | undefined {
  return resolveRoot({
    explicitDir,
    cwd: process.cwd(),
    homedir: os.homedir(),
    hasStore: (dir) => isDir(path.join(dir, '.e')),
  });
}
