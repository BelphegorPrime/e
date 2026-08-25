import { spawnSync } from 'child_process';
import type { Git, WorktreeSpec } from './index';
import { log } from '../utils/log';

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
    return result.status === 0;
  }

  headSha(): string {
    return this.capture(['rev-parse', 'HEAD'], 'resolve HEAD').trim();
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

  addWorktree(spec: WorktreeSpec): void {
    // `-b <branch>` makes the branch; git refuses if it already exists, and
    // refuses if `path` is non-empty — giving us atomic create for free.
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
    return Number(out.trim()) > 0;
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
