import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The Store's **root-finding walk**: locating the directory that holds the
 * `.e` store. `resolveRoot` is pure (the glue supplies cwd, homedir, and a
 * `hasStore` predicate); `findRoot` wires it against the real filesystem. The
 * separation keeps the resolution order — `--dir`, nearest `.e` ancestor of
 * cwd, then home — testable without touching the disk.
 */

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
    hasStore: dir => isDir(path.join(dir, '.e')),
  });
}
