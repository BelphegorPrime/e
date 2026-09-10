import { spawnSync } from 'child_process';
import type { Git, RunCommit, RunRef, WorktreeSpec } from './index.js';
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
    const result = spawnSync(
      'git',
      ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`],
      { stdio: 'ignore', shell: false }
    );
    return result.status === 0;
  }

  addWorktree(spec: WorktreeSpec): void {
    // `-b <branch>` makes the branch; git refuses if it already exists, and
    // refuses if `path` is non-empty — giving us atomic create for free.
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
    this.run(
      ['-C', worktreePath, 'add', '-A'],
      `stage changes in ${worktreePath}`
    );
    this.run(
      ['-C', worktreePath, 'commit', '-m', message],
      `commit changes in ${worktreePath}`
    );
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

  /** Runs a git subcommand for its side effect, throwing on failure. */
  private run(args: string[], description: string): void {
    this.capture(args, description);
  }

  /** Runs a git subcommand and returns its stdout, throwing on failure. */
  private capture(args: string[], description: string): string {
    const result = spawnSync('git', args, { encoding: 'utf8', shell: false });
    if (result.error) {
      throw new Error(
        `Failed to start git (${description}): ${result.error.message}`
      );
    }
    if (result.status !== 0) {
      const detail = result.stderr?.trim() || result.stdout?.trim() || '';
      throw new Error(`git failed (${description}): ${detail}`);
    }
    log.command(description);
    return result.stdout;
  }
}
