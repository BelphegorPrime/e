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
import { parseRunRequest, runList, RunsApi } from './runsApi.js';
import { buildRunIndex } from '../../engine/runs/runIndex.js';
import { runsDirs, writeDeadRequest } from '../../engine/queue/runsSpool.js';

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
      .map(entry =>
        entry.branch === null
          ? []
          : [entry.branch, entry.agent, entry.counter, entry.pushed]
      ),
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

// The ledger and the queue join the index (ADR-0016 section 6).

test('runList: dead requests show as state dead beside queued, metadata only', () => {
  const list = runList(
    [],
    [],
    [],
    [
      {
        request: {
          id: 'trg-01K00000000000000000000009',
          key: 'fix:45',
          trigger: 'fix',
          agent: 'pi',
          prompt: 'the whole prompt',
          payload: { secret: 'never listed' },
          enqueuedAt: '2026-09-29T10:02:00.000Z',
        },
        stage: 'base',
        reason: 'Base error: base "nowhere" does not resolve',
        diedAt: '2026-09-29T10:02:30.000Z',
      },
    ]
  );
  assert.deepEqual(list, [
    {
      branch: null,
      state: 'dead',
      id: 'trg-01K00000000000000000000009',
      agent: 'pi',
      trigger: 'fix',
      key: 'fix:45',
      enqueuedAt: '2026-09-29T10:02:00.000Z',
      stage: 'base',
      reason: 'Base error: base "nowhere" does not resolve',
      diedAt: '2026-09-29T10:02:30.000Z',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(list), /never listed|the whole prompt/);
});

test('runList: queued requests and claims first, then branch runs carrying their ledger state; no payload', () => {
  const index = buildRunIndex(runRefs);
  const list = runList(
    index,
    [
      {
        id: 'trg-01K00000000000000000000001',
        state: 'running',
        slot: true,
        agent: 'claudeCode',
        run: 'e/claudeCode/fix-typos-2',
        container: 'e-claudeCode-fix-typos-2',
        startedAt: '2026-09-29T10:00:00.000Z',
        request: {
          id: 'trg-01K00000000000000000000001',
          key: 'fix:42',
          trigger: 'fix',
          agent: 'claudeCode',
          prompt: 'x',
          payload: { secret: 'never listed' },
          enqueuedAt: '2026-09-29T09:59:00.000Z',
        },
      },
      {
        id: 'trg-01K00000000000000000000002',
        state: 'claimed',
        slot: true,
        agent: 'pi',
        run: null,
        claimedAt: '2026-09-29T10:01:00.000Z',
        request: {
          id: 'trg-01K00000000000000000000002',
          key: 'fix:43',
          trigger: 'fix',
          agent: 'pi',
          prompt: 'x',
          enqueuedAt: '2026-09-29T10:00:30.000Z',
        },
      },
    ],
    [
      {
        id: 'trg-01K00000000000000000000003',
        key: 'fix:44',
        trigger: 'fix',
        agent: 'pi',
        prompt: 'x',
        payload: { secret: 'never listed' },
        enqueuedAt: '2026-09-29T10:02:00.000Z',
      },
    ]
  );
  assert.deepEqual(list.slice(0, 2), [
    {
      branch: null,
      state: 'queued',
      id: 'trg-01K00000000000000000000003',
      agent: 'pi',
      trigger: 'fix',
      key: 'fix:44',
      enqueuedAt: '2026-09-29T10:02:00.000Z',
    },
    {
      branch: null,
      state: 'claimed',
      id: 'trg-01K00000000000000000000002',
      agent: 'pi',
      trigger: 'fix',
      key: 'fix:43',
      enqueuedAt: '2026-09-29T10:00:30.000Z',
      claimedAt: '2026-09-29T10:01:00.000Z',
    },
  ]);
  const running = list.find(item => item.branch === 'e/claudeCode/fix-typos-2');
  assert.equal(running?.state, 'running');
  assert.equal(
    (running as { startedAt?: string }).startedAt,
    '2026-09-29T10:00:00.000Z'
  );
  // A branch the ledger does not know is exactly what it always was.
  assert.deepEqual(
    list.find(item => item.branch === 'e/claudeCode/fix-typos-1'),
    index.find(run => run.branch === 'e/claudeCode/fix-typos-1')
  );
  assert.doesNotMatch(JSON.stringify(list), /never listed/);
});

test('RunsApi.index: the dead spool on disk joins the list as state dead', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'e-runs-dead-'));
  try {
    const dirs = runsDirs(store);
    writeDeadRequest(dirs, {
      request: {
        id: 'trg-01K00000000000000000000009',
        key: 'nightly:20260918T0300Z',
        trigger: 'nightly',
        agent: 'pi',
        prompt: 'p',
        enqueuedAt: '2026-09-18T03:00:10.000Z',
      },
      stage: 'expired',
      reason: 'waited past the queue TTL',
      diedAt: '2026-09-19T03:00:10.000Z',
    });
    const api = new RunsApi({
      git: new InMemoryGit({ refs: [] }),
      worktreesDir: store,
      runs: dirs,
    });
    assert.deepEqual(
      api
        .index()
        .map(item => [item.state, 'stage' in item ? item.stage : undefined]),
      [['dead', 'expired']]
    );
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});
