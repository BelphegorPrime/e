import fs from 'fs';
import path from 'path';
import type { Git } from '../../ports/git/index.js';
import {
  configFilePath,
  dockerComposePath,
  eBaseDir,
  envFilePath,
} from '../../core/store/paths.js';
import {
  chainConfig,
  readConfig,
  resolveConfig,
  type StoreConfig,
} from '../../core/store/config.js';
import { errorMessage } from '../../shared/utils/errors.js';
import type { RunBase } from '../runs/runSpawn.js';

/**
 * **The Base Store** (ADR-0016 section 13): the repository's `.e/` as
 * committed at a triggered run's base, materialized for that one run. In a
 * `pull_request` job every file but the workflow comes from the head, so a
 * head that cannot touch the prompt could still weaken `verify`, swap the
 * agent or rewrite a Dockerfile built on the runner. A one-shot run reads
 * its whole Store from here - `config.json`, agents, Dockerfiles, skills -
 * and nothing of the working tree's `.e/`.
 *
 * A list of files to take from base was rejected: every future Store file
 * would have to join it, and the one that did not would be the hole.
 */

/** Where a one-shot run's Store is, and where it came from. */
export interface BaseStore {
  /** The run's Store root: a scratch directory holding `.e/` as committed at base. */
  root: string;
  /**
   * The checkout's Store root it was cut from, which names what must outlive
   * the scratch copy: the verify cache volume.
   */
  checkoutRoot: string;
}

/** A materialized Base Store and what the human should hear about it. */
export interface MaterializedBaseStore {
  store: BaseStore;
  /** Things that do not stop the run but mean somebody should look. */
  warnings: string[];
  /** Things the run left out on purpose, said once. */
  notices: string[];
}

/** True if something (a file, a directory, a link even a dangling one) is at `p`. */
function present(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** `p` with its links resolved, or `p` itself when it does not exist (yet). */
function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when `child` is `parent` or lies below it. */
function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The checkout's Store root in one-shot: `--dir` when given, else the git
 * toplevel, which holds `.e/`. There is no upward search from the cwd, which
 * would let a head decide where the Store is by committing a nested `.e/`;
 * and a root outside the repository is refused, since nothing there is
 * committed at any base.
 */
export function oneShotStoreRoot(git: Git, dir: string | undefined): string {
  const toplevel = git.toplevel();
  if (toplevel === undefined) {
    throw new Error(
      'e spawn --trigger must be run inside a git repository - the Store is read from base.'
    );
  }
  const root = dir !== undefined ? path.resolve(dir) : toplevel;
  if (!within(real(toplevel), real(root))) {
    throw new Error(
      `--dir ${dir} is outside the repository (${toplevel}): one-shot reads the Store as committed at base, so it must be in the repository`
    );
  }
  return root;
}

/**
 * Removes every link under `dir` that does not resolve to something inside
 * it - one leading out, or leading nowhere, which a later write would follow
 * out - and returns their paths relative to `dir`. One pass suffices: a link
 * through a removed one resolved no better than it did.
 */
function pruneEscapingLinks(dir: string): string[] {
  const top = real(dir);
  const dropped: string[] = [];
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const p = path.join(at, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      let target: string | undefined;
      try {
        target = fs.realpathSync(p);
      } catch {
        target = undefined;
      }
      if (target === undefined || !within(top, target)) {
        fs.rmSync(p, { force: true });
        dropped.push(path.relative(dir, p));
      }
    }
  };
  walk(dir);
  return dropped;
}

/**
 * Materializes the Store at `checkoutRoot` as committed at `base` into
 * `dest` (a directory the run's scratch owns and disposes of), and returns
 * it as the run's Store. The copy never carries a `.env` or a Compose file:
 *
 *  - a `.e/.env` committed at base is a leak somebody must see, so it is
 *    deleted from the copy and the run refused; one only in the head is a
 *    warning, and ignored like the rest of the head. Secrets come only from
 *    `--env-file`.
 *  - `compose.yaml` is left out: one-shot never starts a local stack, which
 *    would run a Compose file from base or, worse, from the head.
 *  - a link leading out of the copy is dropped with a warning.
 */
export function materializeBaseStore(
  git: Git,
  input: { checkoutRoot: string; base: RunBase; dest: string }
): MaterializedBaseStore {
  const { checkoutRoot, base, dest } = input;
  // The sha, not the ref: the commit the run is cut from is the one read.
  git.exportTree(base.sha, eBaseDir(checkoutRoot), eBaseDir(dest));

  const committedEnv = envFilePath(dest);
  if (present(committedEnv)) {
    fs.rmSync(committedEnv, { recursive: true, force: true });
    throw new Error(
      `\`.e/.env\` is committed at ${base.ref}: a committed secret is a leak; remove it from the repository`
    );
  }
  const warnings: string[] = [];
  if (git.readFileAt('HEAD', envFilePath(checkoutRoot)) !== undefined) {
    warnings.push(
      `\`.e/.env\` is committed in HEAD but not at ${base.ref}: it is ignored, one-shot takes secrets only from --env-file; remove it from the branch`
    );
  }
  for (const link of pruneEscapingLinks(dest)) {
    warnings.push(
      `The Base Store's ${link} is a link leading out of it, and was left out`
    );
  }

  const notices: string[] = [];
  const compose = dockerComposePath(dest);
  if (present(compose)) {
    fs.rmSync(compose, { force: true });
    notices.push(
      `The Base Store's compose.yaml is not used: one-shot never starts a local stack`
    );
  }
  return { store: { root: dest, checkoutRoot }, warnings, notices };
}

/**
 * **Hosted's half of the rule** (ADR-0016 section 5, #199): the config a
 * queued run reads when its target repository's settings must come from
 * base. `verify`, `loop` and `resources` resolve from the target's
 * `.e/config.json` as committed at `base` - never from its working tree,
 * which is whatever somebody left checked out, the same reason `HEAD` is
 * refused as a base - over the serving Store's machine settings, as
 * {@link chainConfig} layers them. A target with no `config.json` at base
 * keeps the serving Store's settings, a file on disk notwithstanding.
 *
 * Only `config.json` moves: agents, Dockerfiles, skills and `.env` stay the
 * serving Store's, which is what hosted means. So this reads the one file at
 * the base commit rather than materializing a whole Base Store.
 */
export function readConfigAtBase(
  git: Git,
  input: { serving: string | undefined; target: string; base: RunBase }
): StoreConfig {
  const { serving, target, base } = input;
  const file = configFilePath(target);
  // The sha, not the ref: the commit the run is cut from is the one read.
  const committed = git.readFileAt(base.sha, file);
  if (committed === undefined) {
    return readConfig(serving);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(committed);
  } catch (err) {
    throw new Error(
      `${base.ref}:${path.relative(target, file)} is not valid JSON: ${errorMessage(err)}`,
      { cause: err }
    );
  }
  return chainConfig(readConfig(serving), resolveConfig(raw));
}

/**
 * The config of a run `serve` queued and claimed with a base (ADR-0016
 * section 6): a Store inside the repository the base was resolved in is
 * that repository's own, so its settings come from base through
 * {@link readConfigAtBase}. A Store outside it - a home Store - is in no
 * repository and is read as always.
 *
 * Here the serving Store and the target are one, so "no `config.json` at
 * base keeps the serving settings" would hand the gate straight back to the
 * working tree. It does only when git tracks no `config.json` in HEAD
 * either: then the file is the operator's own and no branch put it there.
 * One that HEAD tracks came with whatever is checked out, and base, which
 * declares none, has no gate and the default caps.
 */
export function readQueuedConfig(
  git: Git,
  root: string | undefined,
  base: RunBase
): StoreConfig {
  const toplevel = git.toplevel();
  if (
    root === undefined ||
    toplevel === undefined ||
    !within(real(toplevel), real(root))
  ) {
    return readConfig(root);
  }
  const file = configFilePath(root);
  if (
    git.readFileAt(base.sha, file) === undefined &&
    git.readFileAt('HEAD', file) !== undefined
  ) {
    return chainConfig(readConfig(root), resolveConfig(undefined));
  }
  return readConfigAtBase(git, { serving: root, target: root, base });
}
