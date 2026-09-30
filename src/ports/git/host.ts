import { spawnSync, type SpawnSyncReturns } from 'child_process';
import fs from 'fs';
import path from 'path';
import type {
  Git,
  MergeOutcome,
  NumstatEntry,
  RunCommit,
  RunRef,
  WorktreeSpec,
} from './index.js';
import { log } from '../../shared/utils/log.js';

/**
 * The paths a refused `git merge` named as in the way, parsed out of its
 * stderr: every indented line (a tab, or two spaces for a staged change)
 * under a header ending in `would be overwritten by merge:` - both the "Your
 * local changes to the following files" and the "following untracked working
 * tree files" blocks, in order, until the next unindented line. Empty when
 * the message is about something else (an unknown ref, a merge in progress).
 */
export function overwrittenPaths(stderr: string): string[] {
  const paths: string[] = [];
  let inBlock = false;
  for (const line of stderr.split('\n')) {
    if (/would be overwritten by merge:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    const match = /^(?:\t| {2})(.+?)\s*$/.exec(line);
    if (match) paths.push(match[1]);
    else inBlock = false;
  }
  return [...new Set(paths)];
}

/**
 * The real `Git` port: shells out to the `git` executable in the host process.
 * Every mutating call throws on non-zero exit so the orchestrator can react
 * (e.g. bump the run counter and retry on an atomic-create collision).
 */
export class HostGit implements Git {
  /**
   * `cwd`: the repository to work on, when it is not the process's cwd - a
   * home Store trigger's target, resolved by `serve` (#201). Absent, every
   * call runs where the process stands, as it always did.
   */
  constructor(private readonly cwd?: string) {}

  /** Where git runs and host paths are relative to. */
  private get here(): string {
    return this.cwd ?? process.cwd();
  }

  isRepo(): boolean {
    const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: this.here,
      stdio: 'ignore',
      shell: false,
    });
    log.debug(`Inside git work tree: ${result.status === 0}`);
    return result.status === 0;
  }

  headSha(worktreePath?: string): string {
    return this.capture(
      [...(worktreePath ? ['-C', worktreePath] : []), 'rev-parse', 'HEAD'],
      worktreePath ? `resolve HEAD of ${worktreePath}` : 'resolve HEAD'
    ).trim();
  }

  currentBranch(): string {
    const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: this.here,
      encoding: 'utf8',
      shell: false,
    });
    if (result.status !== 0) return '';
    const name = (result.stdout ?? '').trim();
    return name === 'HEAD' ? '' : name;
  }

  resolveCommit(ref: string): string | undefined {
    const result = this.spawnGit([
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${ref}^{commit}`,
    ]);
    if (result.status !== 0) return undefined;
    const sha = result.stdout.trim();
    return sha === '' ? undefined : sha;
  }

  toplevel(): string | undefined {
    const result = this.spawnGit(['rev-parse', '--show-toplevel']);
    if (result.status !== 0) return undefined;
    const dir = result.stdout.trim();
    return dir === '' ? undefined : dir;
  }

  readFileAt(ref: string, filePath: string): string | undefined {
    const result = this.spawnGit(['show', revPath(ref, filePath, this.here)]);
    if (result.status !== 0) {
      log.debug(
        `No ${path.relative(this.here, filePath)} at ${ref}: ${result.stderr?.trim() ?? 'git show failed'}`
      );
      return undefined;
    }
    return result.stdout;
  }

  exportTree(ref: string, dirPath: string, dest: string): void {
    const tree = revPath(ref, dirPath, this.here);
    const description = `export ${tree}`;
    // `-z`: NUL-terminated and never quoted, so every file name survives;
    // the paths are relative to that tree. Submodules are commits, not blobs.
    const entries = parseLsTreeZ(
      this.capture(['ls-tree', '-r', '-z', '--full-tree', tree], description)
    ).filter(entry => entry.type === 'blob');
    const blobs = this.readBlobs(
      entries.map(entry => entry.object),
      description
    );
    const root = path.resolve(dest);
    fs.mkdirSync(root, { recursive: true });
    const destOf = (file: string): string => {
      const target = path.resolve(root, file);
      const relative = path.relative(root, target);
      if (relative === '' || relative.startsWith('..')) {
        throw new Error(
          `git failed (${description}): ${file} is not inside the tree`
        );
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      return target;
    };
    // Files first and links last, so no file is ever written through a
    // link this export itself created.
    entries.forEach((entry, i) => {
      if (entry.mode === SYMLINK_MODE) return;
      const target = destOf(entry.path);
      fs.writeFileSync(target, blobs[i]);
      fs.chmodSync(target, parseInt(entry.mode, 8) & 0o111 ? 0o755 : 0o644);
    });
    entries.forEach((entry, i) => {
      if (entry.mode !== SYMLINK_MODE) return;
      fs.symlinkSync(blobs[i].toString('utf8'), destOf(entry.path));
    });
    log.command(description);
  }

  defaultBranchRef(): string | undefined {
    const local = this.spawnGit([
      'symbolic-ref',
      '--quiet',
      'refs/remotes/origin/HEAD',
    ]);
    if (local.status === 0 && local.stdout.trim() !== '') {
      return local.stdout.trim();
    }
    // `ref: refs/heads/main\tHEAD` is the line naming the remote's HEAD.
    const remote = this.spawnGit(['ls-remote', '--symref', 'origin', 'HEAD']);
    if (remote.status !== 0) return undefined;
    const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(remote.stdout);
    return match ? `refs/remotes/origin/${match[1]}` : undefined;
  }

  listRunBranches(prefix: string): string[] {
    // for-each-ref over both local heads and remote-tracking refs; `short`
    // yields `<prefix>-N` for heads and `<remote>/<prefix>-N` for remotes.
    const out = this.capture(
      [
        'for-each-ref',
        '--format=%(refname:short)',
        `refs/heads/${prefix}-*`,
        `refs/remotes/*/${prefix}-*`,
      ],
      `list run branches for ${prefix}`
    );
    return out
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  }

  listRunRefs(prefix: string): RunRef[] {
    // NUL-separated fields so subject text can never collide with the other
    // columns; one `for-each-ref` call covers local heads and remotes. Both
    // branch shapes are enumerated: the `<prefix>-N` form matches via `-*`,
    // and every run branch nests under `refs/heads/e/...` (ADR-0003), so the
    // recursive `/**` form catches a namespace prefix (`e`) whose branches live
    // several segments deep. The glob shapes are disjoint; a ref matching both
    // (e.g. `e/agent/slug-1` matching `-*` and `/**`) is still deduped.
    const out = this.capture(
      [
        'for-each-ref',
        '--sort=-committerdate',
        `--format=%(refname:short)%00%(objectname)%00%(committerdate:iso-strict)%00%(subject)`,
        `refs/heads/${prefix}-*`,
        `refs/heads/${prefix}/**`,
        `refs/remotes/*/${prefix}-*`,
        `refs/remotes/*/${prefix}/**`,
      ],
      `list run refs for ${prefix}`
    );
    const seen = new Set<string>();
    return out
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => {
        const [name, sha, committerDate, subject = ''] = line.split('\0');
        return { name, sha, committerDate, subject };
      })
      .filter(ref => {
        if (seen.has(ref.name)) return false;
        seen.add(ref.name);
        return true;
      });
  }

  runLog(branch: string): RunCommit[] {
    // `git log` does not understand `%00` (unlike for-each-ref), so the NUL
    // separator is `%x00`; otherwise everything lands in the sha column.
    const out = this.capture(
      ['log', `--format=%H%x00%s%x00%cI`, branch],
      `log ${branch}`
    );
    return out
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => {
        const [sha, subject = '', committerDate = ''] = line.split('\0');
        return { sha, subject, committerDate };
      });
  }

  addWorktree(spec: WorktreeSpec): void {
    // `-b <branch>` makes the branch; git refuses if it already exists, and
    // refuses if `path` is non-empty - giving us atomic create for free.
    log.debug(
      `Creating worktree: ${spec.path} -> branch ${spec.branch} at ${spec.base}`
    );
    this.run(
      ['worktree', 'add', '-b', spec.branch, spec.path, spec.base],
      `create worktree for ${spec.branch}`
    );
  }

  checkoutWorktree(worktreePath: string, branch: string): void {
    // No `-b`: an existing branch or nothing. Without a local one, git finds
    // the remote-tracking twin and creates the local branch tracking it.
    log.debug(`Checking out worktree: ${worktreePath} -> branch ${branch}`);
    // A resume after a crash may find the Run's worktree gone (a reboot wiped
    // the temp dir) but still registered, which `worktree add` refuses:
    // forget the registrations whose directories no longer exist first.
    this.run(['worktree', 'prune'], 'prune vanished worktrees');
    this.run(
      ['worktree', 'add', worktreePath, branch],
      `check out worktree for ${branch}`
    );
  }

  isDirty(worktreePath: string): boolean {
    const out = this.capture(
      ['-C', worktreePath, 'status', '--porcelain'],
      `check status of ${worktreePath}`
    );
    return out.trim().length > 0;
  }

  commitAll(worktreePath: string, message: string): void {
    const addParams = ['-C', worktreePath, 'add', '-A'];
    const commitParams = ['-C', worktreePath, 'commit', '-m', message];

    this.run(addParams, `stage changes in ${worktreePath}`);
    try {
      this.run(commitParams, `commit changes in ${worktreePath}`);
    } catch {
      // A pre-commit hook (e.g. prettier --write) may have reformatted the
      // staged files in place and aborted the commit so a human reviews the
      // diff. Since here that diff is machine-generated run output, restage
      // and retry once: if the hook only rewrote files, this second attempt
      // has nothing left to fix and succeeds. A real hook failure (lint
      // error, test failure) fails the same way again and rethrows - the
      // original error's message would be stale after the restage, so let
      // this second failure speak for itself.
      this.run(addParams, `restage hook-modified changes in ${worktreePath}`);
      this.run(commitParams, `retry commit changes in ${worktreePath}`);
    }
  }

  hasCommitsBeyondBase(branch: string, base: string): boolean {
    const out = this.capture(
      ['rev-list', '--count', `${base}..${branch}`],
      `count commits on ${branch} beyond ${base}`
    );
    const count = Number(out.trim());
    log.debug(`Commits on ${branch} beyond ${base}: ${count}`);
    return count > 0;
  }

  numstat(base: string, tip: string, pathspecs: string[]): NumstatEntry[] {
    if (pathspecs.length === 0) {
      throw new Error(
        'numstat needs at least one pathspec (none is every file)'
      );
    }
    return parseNumstatZ(
      this.capture(
        ['diff', '--numstat', '-z', `${base}..${tip}`, '--', ...pathspecs],
        `numstat ${base}..${tip}`
      )
    );
  }

  push(branch: string): void {
    this.run(['push', 'origin', branch], `push ${branch} to origin`);
  }

  removeWorktree(worktreePath: string): void {
    // `--force` because the worktree may hold untracked/ignored files (e.g.
    // node_modules) that plain `remove` would refuse to discard. The branch
    // is untouched.
    this.run(
      ['worktree', 'remove', '--force', worktreePath],
      `remove worktree ${worktreePath}`
    );
  }

  merge(worktreePath: string, branch: string, message?: string): MergeOutcome {
    const description = `merge ${branch} into ${worktreePath}`;
    // A merge still in progress from before makes git refuse with MERGE_HEAD
    // set - indistinguishable, after the fact, from a conflict of this merge.
    // Refuse up front instead, so a stale conflict is never reported under the
    // new branch's name.
    if (this.mergeInProgress(worktreePath)) {
      throw new Error(
        `git failed (${description}): a merge is already in progress in the worktree (MERGE_HEAD set); conclude or abort it first`
      );
    }
    const before = this.headSha(worktreePath);
    // `--no-ff`: a merge commit even when a fast-forward were possible, so the
    // sibling's work is one visible node in the parent's history (ADR-0013).
    // It also makes git refuse on *any* staged change, not only on changes
    // the merge would overwrite (a fast-forward tolerates unrelated ones).
    // `--no-edit`: never open an editor from the host process.
    const result = this.spawnGit([
      '-C',
      worktreePath,
      'merge',
      '--no-ff',
      '--no-edit',
      ...(message !== undefined ? ['-m', message] : []),
      branch,
    ]);
    if (result.error) throw this.failure(description, result);
    if (result.status === 0) {
      log.command(description);
      return this.headSha(worktreePath) === before
        ? { status: 'up-to-date' }
        : { status: 'merged' };
    }
    // Non-zero exit is one of three things: a conflict, which git leaves in
    // progress (MERGE_HEAD set, markers in the files) for someone to resolve;
    // a merge that stopped after the files were merged (a failing
    // pre-merge-commit hook: MERGE_HEAD set, nothing unmerged); or a refusal
    // to even start, which leaves the worktree exactly as it was. A refusal
    // over local changes in the way is an outcome too - the paths live only
    // in git's message, so they are parsed out of it; every other refusal
    // (unknown ref, ...) is an error.
    if (this.mergeInProgress(worktreePath)) {
      const files = this.conflictedFiles(worktreePath);
      if (files.length > 0) {
        log.command(`${description}: conflict in ${files.join(', ')}`);
        return { status: 'conflict', files };
      }
    }
    const inTheWay = overwrittenPaths(result.stderr ?? '');
    if (inTheWay.length > 0) {
      log.command(
        `${description}: refused, in the way: ${inTheWay.join(', ')}`
      );
      return { status: 'refused', files: inTheWay };
    }
    throw this.failure(description, result);
  }

  mergeInProgress(worktreePath: string): boolean {
    return this.refResolves('MERGE_HEAD', worktreePath);
  }

  abortMerge(worktreePath: string): void {
    this.run(
      ['-C', worktreePath, 'merge', '--abort'],
      `abort the merge in ${worktreePath}`
    );
  }

  /** Paths with unmerged index entries, NUL-separated so `core.quotePath` never mangles a name. */
  private conflictedFiles(worktreePath: string): string[] {
    return this.capture(
      ['-C', worktreePath, 'diff', '--name-only', '-z', '--diff-filter=U'],
      `list conflicted files in ${worktreePath}`
    )
      .split('\0')
      .filter(file => file.length > 0);
  }

  /** True if `ref` resolves (`rev-parse --verify --quiet`), in `cwd` when given. */
  private refResolves(ref: string, cwd?: string): boolean {
    const result = spawnSync(
      'git',
      [...(cwd ? ['-C', cwd] : []), 'rev-parse', '--verify', '--quiet', ref],
      { cwd: this.here, stdio: 'ignore', shell: false }
    );
    return result.status === 0;
  }

  /** Runs a git subcommand for its side effect, throwing on failure. */
  private run(args: string[], description: string): void {
    this.capture(args, description);
  }

  /** Runs a git subcommand and returns its stdout, throwing on failure. */
  private capture(args: string[], description: string): string {
    const result = this.spawnGit(args);
    if (result.error || result.status !== 0) {
      throw this.failure(description, result);
    }
    log.command(description);
    return result.stdout;
  }

  /**
   * The contents of `objects`, in order, from one `cat-file --batch`: binary
   * safe, so the output stays a Buffer, with room for a whole Store.
   */
  private readBlobs(objects: string[], description: string): Buffer[] {
    if (objects.length === 0) return [];
    const result = spawnSync('git', ['cat-file', '--batch'], {
      cwd: this.here,
      input: `${objects.join('\n')}\n`,
      maxBuffer: EXPORT_MAX_BYTES,
      shell: false,
    });
    if (result.error) {
      throw new Error(
        `Failed to start git (${description}): ${result.error.message}`
      );
    }
    if (result.status !== 0) {
      throw new Error(
        `git failed (${description}): ${result.stderr.toString().trim()}`
      );
    }
    return parseCatFileBatch(result.stdout, objects.length, description);
  }

  /** Runs `git <args>` capturing stdout/stderr; callers decide what the exit status means. */
  private spawnGit(args: string[]): SpawnSyncReturns<string> {
    return spawnSync('git', args, {
      cwd: this.here,
      encoding: 'utf8',
      shell: false,
    });
  }

  /** The error for a git call that failed to start or exited non-zero. */
  private failure(
    description: string,
    result: SpawnSyncReturns<string>
  ): Error {
    if (result.error) {
      return new Error(
        `Failed to start git (${description}): ${result.error.message}`
      );
    }
    const detail = result.stderr?.trim() || result.stdout?.trim() || '';
    return new Error(`git failed (${description}): ${detail}`);
  }
}

/** The tree-entry mode of a symlink, whose blob is the link's target. */
const SYMLINK_MODE = '120000';

/** Room for every blob of an exported tree at once; a Store is far smaller. */
const EXPORT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * `<ref>:./<path>`, the revision syntax for a host path as committed at
 * `ref`. The `./` makes it relative to the cwd, which is where every other
 * call here runs too; a bare `<ref>:<path>` would be the repo root's.
 */
function revPath(ref: string, filePath: string, cwd: string): string {
  const relative = path.relative(cwd, filePath);
  return `${ref}:${relative.startsWith('..') ? relative : `./${relative}`}`;
}

/** One entry of `git ls-tree -z`. */
interface LsTreeEntry {
  mode: string;
  type: string;
  object: string;
  path: string;
}

/** Reads `git ls-tree -z`: `<mode> <type> <object>\t<path>\0` per entry. */
function parseLsTreeZ(out: string): LsTreeEntry[] {
  return out
    .split('\0')
    .filter(record => record !== '')
    .map(record => {
      const tab = record.indexOf('\t');
      const [mode = '', type = '', object = ''] = record
        .slice(0, tab)
        .split(' ');
      return { mode, type, object, path: record.slice(tab + 1) };
    });
}

/**
 * Reads `git cat-file --batch`: per object `<oid> blob <size>\n`, then
 * `size` bytes and a newline.
 */
function parseCatFileBatch(
  out: Buffer,
  count: number,
  description: string
): Buffer[] {
  const blobs: Buffer[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const eol = out.indexOf(0x0a, at);
    const header = out.subarray(at, eol < 0 ? out.length : eol).toString();
    const match = /^\S+ blob (\d+)$/.exec(header);
    if (eol < 0 || !match) {
      throw new Error(`git failed (${description}): cat-file said ${header}`);
    }
    const start = eol + 1;
    const size = Number(match[1]);
    blobs.push(out.subarray(start, start + size));
    at = start + size + 1;
  }
  return blobs;
}

/**
 * Reads `git diff --numstat -z`: `added\tremoved\tpath\0` per file, and for
 * a rename `added\tremoved\t\0from\0to\0`. NUL-separated so no path is
 * ever quoted or split; `-` counts (a binary file) read as `null`.
 */
export function parseNumstatZ(out: string): NumstatEntry[] {
  const tokens = out.split('\0');
  const entries: NumstatEntry[] = [];
  const count = (raw: string): number | null =>
    raw === '-' ? null : Number(raw);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '') continue;
    const [added, removed, path] = token.split('\t');
    if (path === undefined) continue;
    if (path === '') {
      entries.push({
        from: tokens[i + 1],
        path: tokens[i + 2],
        added: count(added),
        removed: count(removed),
      });
      i += 2;
    } else {
      entries.push({ path, added: count(added), removed: count(removed) });
    }
  }
  return entries;
}
