import { spawnSync, type SpawnSyncReturns } from 'child_process';
import type {
  Git,
  MergeOutcome,
  RunCommit,
  RunRef,
  WorktreeSpec,
} from './index.js';
import { log } from '../utils/log.js';

/**
 * The real `Git` port: shells out to the `git` executable in the host process.
 * Every mutating call throws on non-zero exit so the orchestrator can react
 * (e.g. bump the run counter and retry on an atomic-create collision).
 */
export class HostGit implements Git {
  isRepo(): boolean {
    const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      stdio: 'ignore',
      shell: false,
    });
    log.debug(`Inside git work tree: ${result.status === 0}`);
    return result.status === 0;
  }

  headSha(): string {
    return this.capture(['rev-parse', 'HEAD'], 'resolve HEAD').trim();
  }

  currentBranch(): string {
    const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      shell: false,
    });
    if (result.status !== 0) return '';
    const name = (result.stdout ?? '').trim();
    return name === 'HEAD' ? '' : name;
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

  branchExists(branch: string): boolean {
    // `--quiet` keeps a missing ref from writing to stderr; any exit code
    // other than 0 means the ref does not resolve.
    return this.refResolves(`${branch}^{commit}`);
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
    const head = () =>
      this.capture(
        ['-C', worktreePath, 'rev-parse', 'HEAD'],
        `resolve HEAD of ${worktreePath}`
      ).trim();
    const before = head();
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
      return head() === before
        ? { status: 'up-to-date' }
        : { status: 'merged' };
    }
    // Non-zero exit is one of three things: a conflict, which git leaves in
    // progress (MERGE_HEAD set, markers in the files) for someone to resolve;
    // a merge that stopped after the files were merged (a failing
    // pre-merge-commit hook: MERGE_HEAD set, nothing unmerged); or a refusal
    // to even start (unknown ref, local changes in the way), which leaves the
    // worktree exactly as it was. Only the first is an outcome.
    if (this.mergeInProgress(worktreePath)) {
      const files = this.conflictedFiles(worktreePath);
      if (files.length > 0) {
        log.command(`${description}: conflict in ${files.join(', ')}`);
        return { status: 'conflict', files };
      }
    }
    throw this.failure(description, result);
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

  /** True while a merge is in progress in the worktree (`MERGE_HEAD` resolves). */
  private mergeInProgress(worktreePath: string): boolean {
    return this.refResolves('MERGE_HEAD', worktreePath);
  }

  /** True if `ref` resolves (`rev-parse --verify --quiet`), in `cwd` when given. */
  private refResolves(ref: string, cwd?: string): boolean {
    const result = spawnSync(
      'git',
      [...(cwd ? ['-C', cwd] : []), 'rev-parse', '--verify', '--quiet', ref],
      { stdio: 'ignore', shell: false }
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

  /** Runs `git <args>` capturing stdout/stderr; callers decide what the exit status means. */
  private spawnGit(args: string[]): SpawnSyncReturns<string> {
    return spawnSync('git', args, { encoding: 'utf8', shell: false });
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
