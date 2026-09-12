import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Agent } from '../../core/agent/index.js';
import type {
  Git,
  MergeOutcome,
  RunCommit,
  RunRef,
  WorktreeSpec,
} from '../../ports/git/index.js';
import { nextRunName } from './nextRunName.js';

const agent: Agent = { name: 'demo', harness: 'pi' };

/**
 * The two `Git` methods `nextRunName` uses, scripted; everything else throws,
 * because reaching it would mean the namer grew a dependency it should not
 * have. (One more hand-written `Git` double - the shared in-memory adapter is
 * its own candidate.)
 */
class NamerGit implements Git {
  readonly worktrees: WorktreeSpec[] = [];

  constructor(
    private readonly branches: string[] = [],
    /** Branch names whose `addWorktree` reports a collision. */
    private readonly taken: Set<string> = new Set(),
    /** When set, every `addWorktree` throws this instead. */
    private readonly failWith?: string
  ) {}

  listRunBranches(): string[] {
    return this.branches;
  }

  addWorktree(spec: WorktreeSpec): void {
    if (this.failWith) throw new Error(this.failWith);
    if (this.taken.has(spec.branch)) {
      throw new Error(`fatal: a branch named '${spec.branch}' already exists`);
    }
    this.worktrees.push(spec);
  }

  private unreachable(name: string): never {
    throw new Error(`nextRunName must not call Git.${name}`);
  }
  isRepo(): boolean {
    return this.unreachable('isRepo');
  }
  headSha(): string {
    return this.unreachable('headSha');
  }
  currentBranch(): string {
    return this.unreachable('currentBranch');
  }
  listRunRefs(): RunRef[] {
    return this.unreachable('listRunRefs');
  }
  runLog(): RunCommit[] {
    return this.unreachable('runLog');
  }
  branchExists(): boolean {
    return this.unreachable('branchExists');
  }
  isDirty(): boolean {
    return this.unreachable('isDirty');
  }
  commitAll(): void {
    return this.unreachable('commitAll');
  }
  hasCommitsBeyondBase(): boolean {
    return this.unreachable('hasCommitsBeyondBase');
  }
  push(): void {
    return this.unreachable('push');
  }
  removeWorktree(): void {
    return this.unreachable('removeWorktree');
  }
  merge(): MergeOutcome {
    return this.unreachable('merge');
  }
  mergeInProgress(): boolean {
    return this.unreachable('mergeInProgress');
  }
}

test('the first run of a slug is counter 1', async () => {
  const git = new NamerGit();
  const run = await nextRunName(git, agent, 'fix-login', 'HEAD', '/wt');
  assert.equal(run.branch, 'e/demo/fix-login-1');
  assert.equal(run.name, 'e-demo-fix-login-1');
});

test('the counter continues past the highest existing branch, local or remote', async () => {
  const git = new NamerGit([
    'e/demo/fix-login-1',
    'origin/e/demo/fix-login-4',
    'e/demo/fix-login-2',
  ]);
  const run = await nextRunName(git, agent, 'fix-login', 'HEAD', '/wt');
  assert.equal(run.counter, 5);
});

test('the worktree is cut from base at the branch path under the worktrees dir', async () => {
  const git = new NamerGit();
  const run = await nextRunName(git, agent, 'fix-login', 'abc123', '/wt');
  assert.deepEqual(git.worktrees, [
    {
      path: path.join('/wt', 'e', 'demo', 'fix-login-1'),
      branch: run.branch,
      base: 'abc123',
    },
  ]);
});

test('a branch that appeared since the scan steps the counter and retries', async () => {
  // Another Spawn won the race for -1 and -2 after `listRunBranches` returned.
  const git = new NamerGit(
    [],
    new Set(['e/demo/fix-login-1', 'e/demo/fix-login-2'])
  );
  const run = await nextRunName(git, agent, 'fix-login', 'HEAD', '/wt');
  assert.equal(run.branch, 'e/demo/fix-login-3');
  assert.equal(git.worktrees.length, 1, 'only the winning attempt creates one');
});

test('a failure that is not a collision is rethrown at once', async () => {
  const git = new NamerGit([], new Set(), 'fatal: permission denied');
  await assert.rejects(
    () => nextRunName(git, agent, 'fix-login', 'HEAD', '/wt'),
    /permission denied/
  );
});

test('the retry gives up after maxAttempts', async () => {
  const taken = new Set(
    Array.from({ length: 10 }, (_, i) => `e/demo/fix-login-${i + 1}`)
  );
  const git = new NamerGit([], taken);
  await assert.rejects(
    () => nextRunName(git, agent, 'fix-login', 'HEAD', '/wt', 2),
    /already exists/
  );
});
