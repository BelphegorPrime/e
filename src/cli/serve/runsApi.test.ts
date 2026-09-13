import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { forParts } from '../../core/identity/runName.js';
import { brokerSpoolDirFor } from '../../engine/runs/runBroker.js';
import type { RunCommit, RunRef } from '../../ports/git/index.js';
import { InMemoryGit } from '../../ports/git/memory.js';
import {
  ensureSpool,
  writeRequest,
  writeRunInfo,
} from '../../sidecars/broker/contract/spool.js';
import { parseRunRequest, RunsApi } from './runsApi.js';

const runRefs: RunRef[] = [
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
];

const runCommits: Record<string, RunCommit[]> = {
  'e/claudeCode/fix-typos-2': [
    {
      sha: 'aaa',
      subject: 'e: capture run output for e/claudeCode/fix-typos-2',
      committerDate: '2025-01-02T10:00:00+00:00',
    },
    {
      sha: 'base',
      subject: 'base commit',
      committerDate: '2025-01-01T09:00:00+00:00',
    },
  ],
};

/** A reader over fixed refs; `worktreesDir` is unused by everything but the siblings view. */
function runsOver(
  git = new InMemoryGit({ refs: runRefs, log: runCommits }),
  worktreesDir = path.join(os.tmpdir(), 'e-runs-api-no-spools')
): RunsApi {
  return new RunsApi({ git, worktreesDir });
}

/** The run a fixture branch names, for the calls that take an identity. */
function run(branch: string) {
  const parsed = parseRunRequest(`/api/runs/${branch}`);
  assert.ok(parsed, `${branch} is a run branch`);
  return parsed.run;
}

test('parseRunRequest reads the branch and the view out of a path', () => {
  const views = [
    ['/api/runs/e/claudeCode/fix-typos-2', 'status'],
    ['/api/runs/e/claudeCode/fix-typos-2/logs', 'logs'],
    ['/api/runs/e/claudeCode/fix-typos-2/siblings', 'siblings'],
    ['/api/runs/e/claudeCode/fix-typos-2/siblings/events', 'siblingEvents'],
  ] as const;
  for (const [apiPath, view] of views) {
    const parsed = parseRunRequest(apiPath);
    assert.equal(parsed?.view, view, apiPath);
    assert.equal(parsed?.run.branch, 'e/claudeCode/fix-typos-2', apiPath);
    assert.equal(parsed?.run.agent, 'claudeCode', apiPath);
    assert.equal(parsed?.run.counter, 2, apiPath);
  }
});

test('parseRunRequest: a remote-tracking spelling resolves to the same Run', () => {
  // `fromBranch` owns the rule, so `origin/` never leaks into the identity.
  assert.equal(
    parseRunRequest('/api/runs/origin/e/pi/tidy-1/logs')?.run.branch,
    'e/pi/tidy-1'
  );
});

test('parseRunRequest: anything that is not a run path is undefined', () => {
  for (const apiPath of [
    '/api/runs/',
    '/api/runs/main',
    '/api/runs/not-a-run',
    '/api/runs/e/README',
    '/api/runs/e/pi/no-counter',
    '/api/runs/e/pi/only-logs-1/other',
    '/api/egress/e/pi/task-1',
    '/api/runs',
  ]) {
    assert.equal(parseRunRequest(apiPath), undefined, apiPath);
  }
});

test('index: the branch-backed runs list, newest first, with local and pushed flags', () => {
  assert.deepEqual(
    runsOver()
      .index()
      .map(entry => [entry.branch, entry.agent, entry.counter, entry.pushed]),
    [
      ['e/claudeCode/fix-typos-2', 'claudeCode', 2, true],
      ['e/claudeCode/fix-typos-1', 'claudeCode', 1, false],
    ]
  );
});

test('index: a local-only run is a full run identity plus its tip', () => {
  const runs = runsOver(new InMemoryGit({ refs: [runRefs[2]!] }));
  assert.deepEqual(runs.index(), [
    {
      // A run index entry is a RunName plus its tip metadata, so the dashed
      // run name and the private network travel with it.
      branch: 'e/claudeCode/fix-typos-1',
      agent: 'claudeCode',
      slug: 'fix-typos',
      counter: 1,
      name: 'e-claudeCode-fix-typos-1',
      network: 'e-claudeCode-fix-typos-1-net',
      sha: 'bbb',
      committerDate: '2025-01-01T09:00:00+00:00',
      subject: 'older run',
      local: true,
      pushed: false,
    },
  ]);
});

test('status: the run identity plus its commit count and tip', () => {
  assert.deepEqual(runsOver().status(run('e/claudeCode/fix-typos-2')), {
    branch: 'e/claudeCode/fix-typos-2',
    agent: 'claudeCode',
    slug: 'fix-typos',
    counter: 2,
    commits: 2,
    latest: runCommits['e/claudeCode/fix-typos-2']![0],
    local: true,
    pushed: true,
  });
});

test('logs: the branch commit history', () => {
  assert.deepEqual(runsOver().logs(run('e/claudeCode/fix-typos-2')), {
    branch: 'e/claudeCode/fix-typos-2',
    commits: runCommits['e/claudeCode/fix-typos-2'],
  });
});

test('status and logs read a remote-only run from its remote-tracking ref', () => {
  const remoteOnly: RunRef = {
    name: 'origin/e/cheap-codex/tidy-tests-1',
    sha: 'ccc',
    committerDate: '2025-01-03T08:00:00+00:00',
    subject: 'remote-only run',
  };
  const commits: Record<string, RunCommit[]> = {
    'origin/e/cheap-codex/tidy-tests-1': [
      {
        sha: 'ccc',
        subject: 'remote-only run',
        committerDate: '2025-01-03T08:00:00+00:00',
      },
    ],
  };
  const runs = runsOver(new InMemoryGit({ refs: [remoteOnly], log: commits }));
  const identity = run('e/cheap-codex/tidy-tests-1');
  const status = runs.status(identity);
  assert.deepEqual(
    {
      branch: status?.branch,
      local: status?.local,
      pushed: status?.pushed,
      commits: status?.commits,
    },
    {
      branch: 'e/cheap-codex/tidy-tests-1',
      local: false,
      pushed: true,
      commits: 1,
    }
  );
  assert.deepEqual(runs.logs(identity), {
    branch: 'e/cheap-codex/tidy-tests-1',
    commits: commits['origin/e/cheap-codex/tidy-tests-1'],
  });
});

test('status and logs are undefined for a branch that never ran', () => {
  const runs = runsOver();
  const never = run('e/claudeCode/never-ran-9');
  assert.equal(runs.status(never), undefined);
  assert.equal(runs.logs(never), undefined);
});

test('a git failure is thrown, not swallowed into an empty index', () => {
  const runs = runsOver(
    new InMemoryGit({
      refs: runRefs,
      fail: { listRunRefs: 'not a repository' },
    })
  );
  assert.throws(() => runs.index(), /not a repository/);
  assert.throws(
    () => runs.status(run('e/claudeCode/fix-typos-2')),
    /not a repository/
  );
});

test('siblings come from the run spool; a run without one has none', t => {
  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-runs-api-'));
  t.after(() => fs.rmSync(worktreesDir, { recursive: true, force: true }));
  const spool = brokerSpoolDirFor(worktreesDir, forParts('pi', 'task', 1));
  ensureSpool(spool);
  writeRunInfo(spool, {
    name: 'e-pi-task-1',
    branch: 'e/pi/task-1',
    agent: 'pi',
    role: 'parent',
    maxSiblings: 3,
  });
  writeRequest(spool, {
    id: 'sib-001',
    agent: 'r',
    prompt: 'p',
    requestedAt: 't',
  });

  const runs = runsOver(new InMemoryGit({ refs: [] }), worktreesDir);
  const withSpool = runs.siblings(run('e/pi/task-1'));
  assert.equal(withSpool.run?.name, 'e-pi-task-1');
  assert.deepEqual(
    withSpool.siblings.map(sibling => [sibling.id, sibling.taskState]),
    [['sib-001', 'submitted']]
  );
  assert.deepEqual(runs.siblings(run('e/pi/other-2')), {
    run: null,
    siblings: [],
  });
});
