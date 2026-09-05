import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunRef } from './git/index';
import { buildRunIndex, parseRunBranch, resolveRunRef } from './runIndex';

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

test('parseRunBranch parses local and remote run short names', () => {
  assert.deepEqual(parseRunBranch('e/claudeCode/fix-typos-2'), {
    branch: 'e/claudeCode/fix-typos-2',
    agent: 'claudeCode',
    slug: 'fix-typos',
    counter: 2,
  });
  assert.deepEqual(parseRunBranch('origin/e/cheap-codex/tidy-tests-1'), {
    branch: 'e/cheap-codex/tidy-tests-1',
    agent: 'cheap-codex',
    slug: 'tidy-tests',
    counter: 1,
  });
});

test('parseRunBranch keeps digits inside the slug', () => {
  assert.deepEqual(parseRunBranch('e/demo/fix-issue-404-7'), {
    branch: 'e/demo/fix-issue-404-7',
    agent: 'demo',
    slug: 'fix-issue-404',
    counter: 7,
  });
});

test('parseRunBranch rejects non-run branches', () => {
  assert.equal(parseRunBranch('e/README'), undefined);
  assert.equal(parseRunBranch('main'), undefined);
  assert.equal(parseRunBranch('e/agent'), undefined);
  assert.equal(parseRunBranch('e/agent/slug'), undefined);
  // A remote segment of `e` collides with the run namespace itself.
  assert.equal(parseRunBranch('e/e/agent/slug-1'), undefined);
});

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
