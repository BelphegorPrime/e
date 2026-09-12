import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunRef } from '../../ports/git/index.js';
import { buildRunIndex, resolveRunRef } from './runIndex.js';

const refs: RunRef[] = [
  {
    name: 'e/claudeCode/fix-typos-2',
    sha: 'aaa',
    committerDate: '2025-01-02T10:00:00+00:00',
    subject: 'e: capture run output for e/claudeCode/fix-typos-2',
  },
  {
    name: 'origin/e/claudeCode/fix-typos-2',
    sha: 'aaa',
    committerDate: '2025-01-02T10:00:00+00:00',
    subject: 'e: capture run output for e/claudeCode/fix-typos-2',
  },
  {
    name: 'e/claudeCode/fix-typos-1',
    sha: 'bbb',
    committerDate: '2025-01-01T09:00:00+00:00',
    subject: 'older run',
  },
  {
    name: 'origin/e/cheap-codex/tidy-tests-1',
    sha: 'ccc',
    committerDate: '2025-01-03T08:00:00+00:00',
    subject: 'remote-only run',
  },
];

test('buildRunIndex merges local and remote twins, local metadata wins', () => {
  const runs = buildRunIndex(refs);
  assert.equal(runs.length, 3);

  const typos = runs.find(run => run.branch === 'e/claudeCode/fix-typos-2');
  assert.ok(typos);
  assert.equal(typos.agent, 'claudeCode');
  assert.equal(typos.counter, 2);
  assert.equal(typos.local, true);
  assert.equal(typos.pushed, true);
  // Local twin's metadata survives regardless of enumeration order.
  assert.equal(typos.sha, 'aaa');

  const remoteOnly = runs.find(
    run => run.branch === 'e/cheap-codex/tidy-tests-1'
  );
  assert.ok(remoteOnly);
  assert.equal(remoteOnly.local, false);
  assert.equal(remoteOnly.pushed, true);
});

test('buildRunIndex sorts newest run first and skips non-runs', () => {
  const runs = buildRunIndex([
    ...refs,
    { name: 'e/scratch', sha: 'x', committerDate: 'z', subject: 'wip' },
    { name: 'main', sha: 'x', committerDate: 'z', subject: 'main' },
  ]);
  assert.deepEqual(
    runs.map(run => run.branch),
    [
      'e/cheap-codex/tidy-tests-1',
      'e/claudeCode/fix-typos-2',
      'e/claudeCode/fix-typos-1',
    ]
  );
});

test('resolveRunRef prefers the local head over a remote twin', () => {
  assert.deepEqual(resolveRunRef(refs, 'e/claudeCode/fix-typos-2'), {
    name: 'e/claudeCode/fix-typos-2',
    sha: 'aaa',
    committerDate: '2025-01-02T10:00:00+00:00',
    subject: 'e: capture run output for e/claudeCode/fix-typos-2',
  });
});

test('resolveRunRef falls back to the remote-tracking ref', () => {
  assert.deepEqual(
    resolveRunRef(refs, 'e/cheap-codex/tidy-tests-1')?.name,
    'origin/e/cheap-codex/tidy-tests-1'
  );
});

test('resolveRunRef returns undefined for an unknown branch', () => {
  assert.equal(resolveRunRef(refs, 'e/demo/never-ran-1'), undefined);
});
