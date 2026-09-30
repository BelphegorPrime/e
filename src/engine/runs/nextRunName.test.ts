import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from '../../core/agent/index.js';
import { HostGit } from '../../ports/git/host.js';
import { git as runGit, initRepo } from '../../ports/git/host.testSupport.js';
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
    () =>
      nextRunName(git, agent, 'fix-login', 'HEAD', '/wt', { maxAttempts: 2 }),
    /already exists/
  );
});

/*
 * Several repositories, one namespace (#208): a home Store's triggers cut runs
 * in several repositories, but the worktree path, the container and the
 * session are keyed by the run name alone.
 */

test('the counter continues past the runs of every repository in the namespace', async () => {
  const git = new InMemoryGit({ branches: ['e/demo/fix-login-1'] });
  const other = new InMemoryGit({
    branches: ['e/demo/fix-login-3', 'origin/e/demo/fix-login-6'],
  });
  const run = await nextRunName(git, agent, 'fix-login', 'HEAD', '/wt', {
    runNamespace: [other],
  });
  assert.equal(run.counter, 7);
  assert.deepEqual(
    other.worktrees,
    [],
    'the worktree is cut in this repository only'
  );
});

test('a namespace repository that cannot be listed is skipped', async () => {
  const git = new InMemoryGit({ branches: ['e/demo/fix-login-2'] });
  const gone = new InMemoryGit({
    fail: { listRunBranches: 'fatal: not a git repository' },
  });
  const run = await nextRunName(git, agent, 'fix-login', 'HEAD', '/wt', {
    runNamespace: [gone],
  });
  assert.equal(run.counter, 3);
});

test('two repositories cutting the same run on one host get distinct names', async () => {
  const repoA = initRepo('e-ns-a-');
  const repoB = initRepo('e-ns-b-');
  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-ns-wt-'));
  try {
    const a = new HostGit(repoA);
    const b = new HostGit(repoB);
    const [first, second] = await Promise.all([
      nextRunName(a, agent, 'nightly', 'HEAD', worktreesDir, {
        runNamespace: [b],
      }),
      nextRunName(b, agent, 'nightly', 'HEAD', worktreesDir, {
        runNamespace: [a],
      }),
    ]);
    assert.equal(first.name, 'e-demo-nightly-1');
    assert.equal(second.name, 'e-demo-nightly-2');
    assert.equal(runGit(repoB, 'branch', '--list', 'e/demo/nightly-1'), '');
  } finally {
    for (const dir of [repoA, repoB, worktreesDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('the host-wide worktree path steps the counter even outside the namespace', async () => {
  // A repository no trigger names (a manual spawn elsewhere) still cannot
  // take a live run's name: its worktree path is taken on this host.
  const repoA = initRepo('e-ns-a-');
  const repoB = initRepo('e-ns-b-');
  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-ns-wt-'));
  try {
    const first = await nextRunName(
      new HostGit(repoA),
      agent,
      'nightly',
      'HEAD',
      worktreesDir
    );
    const second = await nextRunName(
      new HostGit(repoB),
      agent,
      'nightly',
      'HEAD',
      worktreesDir
    );
    assert.equal(first.counter, 1);
    assert.equal(second.counter, 2);
    // The loser kept no branch of the name it lost.
    assert.equal(runGit(repoB, 'branch', '--list', 'e/demo/nightly-1'), '');
  } finally {
    for (const dir of [repoA, repoB, worktreesDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
