import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Agent } from '../../core/agent/index.js';
import { InMemoryGit } from '../../ports/git/memory.js';
import { nextRunName } from './nextRunName.js';

const agent: Agent = { name: 'demo', harness: 'pi' };

test('the first run of a slug is counter 1', async () => {
  const git = new InMemoryGit();
  const run = await nextRunName(git, agent, 'fix-login', 'HEAD', '/wt');
  assert.equal(run.branch, 'e/demo/fix-login-1');
  assert.equal(run.name, 'e-demo-fix-login-1');
});

test('the counter continues past the highest existing branch, local or remote', async () => {
  const git = new InMemoryGit({
    branches: [
      'e/demo/fix-login-1',
      'origin/e/demo/fix-login-4',
      'e/demo/fix-login-2',
    ],
  });
  const run = await nextRunName(git, agent, 'fix-login', 'HEAD', '/wt');
  assert.equal(run.counter, 5);
});

test('the worktree is cut from base at the branch path under the worktrees dir', async () => {
  const git = new InMemoryGit();
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
  const git = new InMemoryGit({
    collide: ['e/demo/fix-login-1', 'e/demo/fix-login-2'],
  });
  const run = await nextRunName(git, agent, 'fix-login', 'HEAD', '/wt');
  assert.equal(run.branch, 'e/demo/fix-login-3');
  assert.equal(git.worktrees.length, 1, 'only the winning attempt creates one');
});

test('a failure that is not a collision is rethrown at once', async () => {
  const git = new InMemoryGit({
    fail: { addWorktree: 'fatal: permission denied' },
  });
  await assert.rejects(
    () => nextRunName(git, agent, 'fix-login', 'HEAD', '/wt'),
    /permission denied/
  );
});

test('the retry gives up after maxAttempts', async () => {
  const taken = new Set(
    Array.from({ length: 10 }, (_, i) => `e/demo/fix-login-${i + 1}`)
  );
  const git = new InMemoryGit({ collide: [...taken] });
  await assert.rejects(
    () => nextRunName(git, agent, 'fix-login', 'HEAD', '/wt', 2),
    /already exists/
  );
});
