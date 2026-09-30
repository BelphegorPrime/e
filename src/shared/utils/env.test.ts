import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Env, env, type ProvenanceVars } from './env.js';

const VARS = [
  'LOCAL_LLAMA_URL',
  'SHOULD_WRITE_LOG_FILE',
  Env.SERVE_DETACHED_VAR,
  Env.SPAWN_ROLE_VAR,
  Env.SPAWN_PARENT_WORKTREE_VAR,
  Env.SPAWN_PARENT_BRANCH_VAR,
  Env.SPAWN_PARENT_NETWORK_VAR,
  Env.SPAWN_SPOOL_VAR,
  Env.SPAWN_SIBLING_ID_VAR,
  Env.TTY_HEADLESS_VAR,
  Env.SPAWN_REPORT_SPOOL_VAR,
  Env.SPAWN_REPORT_ID_VAR,
  Env.SPAWN_FUSION_VAR,
  Env.SPAWN_FUSION_BASE_SHA_VAR,
  Env.SPAWN_FUSION_BASE_REF_VAR,
  Env.SPAWN_FUSION_BASE_BRANCH_VAR,
  Env.A2A_TOKEN_VAR,
  Env.GITHUB_EVENT_NAME_VAR,
  Env.STORE_ENV_FILE_VAR,
  Env.ONE_SHOT_VAR,
  Env.TRIGGER_VAR,
  Env.EVENT_VAR,
  Env.EVENT_URL_VAR,
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map(name => [name, process.env[name]]));
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

test('localLlamaUrl falls back to the default router URL when unset', () => {
  delete process.env.LOCAL_LLAMA_URL;
  assert.equal(env.localLlamaUrl, 'http://127.0.0.1:9931');
});

test('localLlamaUrl reflects LOCAL_LLAMA_URL when set', () => {
  process.env.LOCAL_LLAMA_URL = 'http://example.test:1234';
  assert.equal(env.localLlamaUrl, 'http://example.test:1234');
});

test('shouldWriteLogFile is true only for the literal string "true"', () => {
  process.env.SHOULD_WRITE_LOG_FILE = 'true';
  assert.equal(env.shouldWriteLogFile, true);
  process.env.SHOULD_WRITE_LOG_FILE = 'yes';
  assert.equal(env.shouldWriteLogFile, false);
  delete process.env.SHOULD_WRITE_LOG_FILE;
  assert.equal(env.shouldWriteLogFile, false);
});

test('serveDetached reflects the marker variable', () => {
  delete process.env[Env.SERVE_DETACHED_VAR];
  assert.equal(env.serveDetached, false);
  process.env[Env.SERVE_DETACHED_VAR] = '1';
  assert.equal(env.serveDetached, true);
});

test('withServeDetached copies the base env and sets the marker without mutating it', () => {
  const base = { FOO: 'bar' };
  const result = env.withServeDetached(base);
  assert.equal(result.FOO, 'bar');
  assert.equal(result[Env.SERVE_DETACHED_VAR], '1');
  assert.equal(Env.SERVE_DETACHED_VAR in base, false);
});

test('spawnRole defaults to parent when the marker is unset or blank', () => {
  delete process.env[Env.SPAWN_ROLE_VAR];
  assert.equal(env.spawnRole, 'parent');
  process.env[Env.SPAWN_ROLE_VAR] = '  ';
  assert.equal(env.spawnRole, 'parent');
});

test('spawnRole reflects the marker and rejects unknown roles', () => {
  process.env[Env.SPAWN_ROLE_VAR] = 'child';
  assert.equal(env.spawnRole, 'child');
  process.env[Env.SPAWN_ROLE_VAR] = 'grandchild';
  assert.throws(
    () => env.spawnRole,
    /Unknown run role "grandchild" in E_SPAWN_ROLE/
  );
});

test('sibling is undefined when no marker is set, complete when all are, an error in between', () => {
  for (const name of [
    Env.SPAWN_PARENT_WORKTREE_VAR,
    Env.SPAWN_PARENT_BRANCH_VAR,
    Env.SPAWN_PARENT_NETWORK_VAR,
    Env.SPAWN_SPOOL_VAR,
    Env.SPAWN_SIBLING_ID_VAR,
  ]) {
    delete process.env[name];
  }
  const none = env.sibling;
  assert.equal(none, undefined);
  process.env[Env.SPAWN_PARENT_WORKTREE_VAR] = '/wt/parent';
  process.env[Env.SPAWN_PARENT_BRANCH_VAR] = 'e/demo/parent-1';
  process.env[Env.SPAWN_SPOOL_VAR] = '/wt/.broker/e-demo-parent-1';
  assert.throws(() => env.sibling, /Incomplete sibling markers/);
  process.env[Env.SPAWN_SIBLING_ID_VAR] = 'sib-001';
  const complete = env.sibling;
  assert.deepEqual(complete, {
    parent: {
      worktreePath: '/wt/parent',
      branch: 'e/demo/parent-1',
      network: undefined,
    },
    spoolDir: '/wt/.broker/e-demo-parent-1',
    id: 'sib-001',
  });
  process.env[Env.SPAWN_PARENT_NETWORK_VAR] = 'e-demo-parent-1-net';
  const withNetwork = env.sibling;
  assert.equal(withNetwork?.parent.network, 'e-demo-parent-1-net');
});

test('withSibling sets the child role and every marker, drops the serve and terminal markers, and does not mutate the base', () => {
  const base = {
    FOO: 'bar',
    [Env.SERVE_DETACHED_VAR]: '1',
    [Env.TTY_HEADLESS_VAR]: '1',
    [Env.SPAWN_PARENT_NETWORK_VAR]: 'stale-net',
  };
  const result = env.withSibling(
    {
      parent: { worktreePath: '/wt/parent', branch: 'e/demo/parent-1' },
      spoolDir: '/spool',
      id: 'sib-002',
    },
    base
  );
  assert.equal(result.FOO, 'bar');
  assert.equal(result[Env.SPAWN_ROLE_VAR], 'child');
  assert.equal(result[Env.SPAWN_PARENT_WORKTREE_VAR], '/wt/parent');
  assert.equal(result[Env.SPAWN_PARENT_BRANCH_VAR], 'e/demo/parent-1');
  assert.equal(Env.SPAWN_PARENT_NETWORK_VAR in result, false);
  assert.equal(result[Env.SPAWN_SPOOL_VAR], '/spool');
  assert.equal(result[Env.SPAWN_SIBLING_ID_VAR], 'sib-002');
  assert.equal(Env.SERVE_DETACHED_VAR in result, false);
  assert.equal(Env.TTY_HEADLESS_VAR in result, false);
  assert.equal(base[Env.SERVE_DETACHED_VAR], '1');
  const withNet = env.withSibling(
    {
      parent: { worktreePath: '/p', branch: 'b', network: 'p-net' },
      spoolDir: '/s',
      id: 'sib-003',
    },
    {}
  );
  assert.equal(withNet[Env.SPAWN_PARENT_NETWORK_VAR], 'p-net');
});

test('report markers (ADR-0015): undefined when unset, complete when both are set, an error with one', () => {
  delete process.env[Env.SPAWN_REPORT_SPOOL_VAR];
  delete process.env[Env.SPAWN_REPORT_ID_VAR];
  assert.equal(env.report, undefined);
  process.env[Env.SPAWN_REPORT_SPOOL_VAR] = '/spool';
  assert.throws(() => env.report, /Incomplete report markers/);
  process.env[Env.SPAWN_REPORT_ID_VAR] = 'a2a-001';
  assert.deepEqual(env.report, { spoolDir: '/spool', id: 'a2a-001' });
});

test('withReport sets the report markers and drops the serve, terminal and sibling markers; withSibling drops the report markers', () => {
  const base = {
    PATH: '/bin',
    [Env.SERVE_DETACHED_VAR]: '1',
    [Env.TTY_HEADLESS_VAR]: '1',
    [Env.SPAWN_ROLE_VAR]: 'child',
    [Env.SPAWN_SPOOL_VAR]: '/old',
    [Env.SPAWN_SIBLING_ID_VAR]: 'sib-001',
  };
  const copy = env.withReport({ spoolDir: '/spool', id: 'a2a-002' }, base);
  assert.deepEqual(copy, {
    PATH: '/bin',
    [Env.SPAWN_REPORT_SPOOL_VAR]: '/spool',
    [Env.SPAWN_REPORT_ID_VAR]: 'a2a-002',
  });
  assert.equal(base[Env.SERVE_DETACHED_VAR], '1');
  const sibling = env.withSibling(
    {
      parent: { worktreePath: '/wt', branch: 'b' },
      spoolDir: '/s',
      id: 'sib-002',
    },
    copy
  );
  assert.equal(sibling[Env.SPAWN_REPORT_SPOOL_VAR], undefined);
  assert.equal(sibling[Env.SPAWN_REPORT_ID_VAR], undefined);
});

const pinned = { sha: 'abc123', ref: 'refs/heads/main', branch: 'main' };

test('fusion candidate markers (ADR-0019): undefined when unset, complete with the report markers, an error otherwise', () => {
  for (const name of [
    Env.SPAWN_FUSION_VAR,
    Env.SPAWN_FUSION_BASE_SHA_VAR,
    Env.SPAWN_FUSION_BASE_REF_VAR,
    Env.SPAWN_FUSION_BASE_BRANCH_VAR,
    Env.SPAWN_REPORT_SPOOL_VAR,
    Env.SPAWN_REPORT_ID_VAR,
  ]) {
    delete process.env[name];
  }
  assert.equal(env.fusionCandidate, undefined);
  process.env[Env.SPAWN_FUSION_VAR] = 'fusion-X';
  assert.throws(
    () => env.fusionCandidate,
    /Incomplete fusion candidate markers/
  );
  process.env[Env.SPAWN_FUSION_BASE_SHA_VAR] = pinned.sha;
  process.env[Env.SPAWN_FUSION_BASE_REF_VAR] = pinned.ref;
  process.env[Env.SPAWN_FUSION_BASE_BRANCH_VAR] = pinned.branch;
  // A candidate is always watched: its fusion reads its end from the spool.
  assert.throws(
    () => env.fusionCandidate,
    /A fusion candidate needs the report markers/
  );
  process.env[Env.SPAWN_REPORT_SPOOL_VAR] = '/spool';
  process.env[Env.SPAWN_REPORT_ID_VAR] = 'cand-001';
  assert.deepEqual(env.fusionCandidate, { fusion: 'fusion-X', base: pinned });
});

test('withFusionCandidate: the report and candidate markers set; no sibling, report or ledger child inherits them', () => {
  const copy = env.withFusionCandidate(
    { spoolDir: '/spool', id: 'cand-002' },
    { fusion: 'fusion-X', base: pinned },
    {
      PATH: '/bin',
      [Env.SPAWN_ROLE_VAR]: 'child',
      [Env.SPAWN_SIBLING_ID_VAR]: 'sib-001',
    }
  );
  assert.deepEqual(copy, {
    PATH: '/bin',
    [Env.SPAWN_REPORT_SPOOL_VAR]: '/spool',
    [Env.SPAWN_REPORT_ID_VAR]: 'cand-002',
    [Env.SPAWN_FUSION_VAR]: 'fusion-X',
    [Env.SPAWN_FUSION_BASE_SHA_VAR]: 'abc123',
    [Env.SPAWN_FUSION_BASE_REF_VAR]: 'refs/heads/main',
    [Env.SPAWN_FUSION_BASE_BRANCH_VAR]: 'main',
  });
  // A candidate's own sibling branches from the candidate, not the fusion base,
  // and a run it hands on is a run of its own.
  const sibling = env.withSibling(
    {
      parent: { worktreePath: '/wt', branch: 'b' },
      spoolDir: '/s',
      id: 'sib-001',
    },
    copy
  );
  const report = env.withReport({ spoolDir: '/r', id: 'a2a-001' }, copy);
  const ledger = env.withLedger('/live/x.json', copy);
  for (const child of [sibling, report, ledger]) {
    assert.equal(child[Env.SPAWN_FUSION_VAR], undefined);
    assert.equal(child[Env.SPAWN_FUSION_BASE_SHA_VAR], undefined);
    assert.equal(child[Env.SPAWN_FUSION_BASE_REF_VAR], undefined);
    assert.equal(child[Env.SPAWN_FUSION_BASE_BRANCH_VAR], undefined);
  }
});

test('a2aToken is the trimmed E_A2A_TOKEN, undefined when unset or blank', () => {
  delete process.env[Env.A2A_TOKEN_VAR];
  assert.equal(env.a2aToken, undefined);
  process.env[Env.A2A_TOKEN_VAR] = '  ';
  assert.equal(env.a2aToken, undefined);
  process.env[Env.A2A_TOKEN_VAR] = ' secret ';
  assert.equal(env.a2aToken, 'secret');
});

test('withLedger sets E_LEDGER_FILE and drops every other role marker; siblings and watched children never inherit it', () => {
  const base = {
    PATH: '/bin',
    [Env.SPAWN_REPORT_SPOOL_VAR]: '/spool',
    [Env.SPAWN_REPORT_ID_VAR]: 'a2a-001',
    [Env.SPAWN_ROLE_VAR]: 'child',
    [Env.SERVE_DETACHED_VAR]: '1',
  };
  const copy = env.withLedger('/s/.e/runs/live/trg-x.json', base);
  assert.equal(copy[Env.LEDGER_FILE_VAR], '/s/.e/runs/live/trg-x.json');
  assert.equal(copy.PATH, '/bin');
  for (const name of [
    Env.SPAWN_REPORT_SPOOL_VAR,
    Env.SPAWN_REPORT_ID_VAR,
    Env.SPAWN_ROLE_VAR,
    Env.SERVE_DETACHED_VAR,
  ]) {
    assert.equal(name in copy, false, name);
  }
  // A sibling or an A2A child of a queued run is a run of its own: patching
  // the parent's entry would end the parent's slot on the child's exit.
  const queued = { PATH: '/bin', [Env.LEDGER_FILE_VAR]: '/x.json' };
  assert.equal(
    Env.LEDGER_FILE_VAR in
      env.withSibling(
        {
          parent: { worktreePath: '/w', branch: 'e/pi/x-1' },
          spoolDir: '/spool',
          id: 'sib-001',
        },
        queued
      ),
    false
  );
  assert.equal(
    Env.LEDGER_FILE_VAR in
      env.withReport({ spoolDir: '/spool', id: 'a2a-001' }, queued),
    false
  );
});

test('githubEventName is the trimmed GITHUB_EVENT_NAME, undefined when unset or blank', () => {
  delete process.env[Env.GITHUB_EVENT_NAME_VAR];
  assert.equal(env.githubEventName, undefined);
  process.env[Env.GITHUB_EVENT_NAME_VAR] = ' ';
  assert.equal(env.githubEventName, undefined);
  process.env[Env.GITHUB_EVENT_NAME_VAR] = 'issues\n';
  assert.equal(env.githubEventName, 'issues');
});

test('storeEnvFile is the trimmed E_STORE_ENV_FILE; a sibling keeps it, a run of its own does not', () => {
  assert.equal(env.storeEnvFile, undefined);
  process.env[Env.STORE_ENV_FILE_VAR] = ' ';
  assert.equal(env.storeEnvFile, undefined);
  process.env[Env.STORE_ENV_FILE_VAR] = ' /tmp/e.env ';
  assert.equal(env.storeEnvFile, '/tmp/e.env');
  const carrying = { PATH: '/bin', [Env.STORE_ENV_FILE_VAR]: '/tmp/e.env' };
  assert.equal(
    env.withSibling(
      {
        parent: { worktreePath: '/w', branch: 'e/pi/x-1' },
        spoolDir: '/spool',
        id: 'sib-001',
      },
      carrying
    )[Env.STORE_ENV_FILE_VAR],
    '/tmp/e.env'
  );
  for (const copy of [
    env.withReport({ spoolDir: '/spool', id: 'a2a-001' }, carrying),
    env.withLedger('/x.json', carrying),
  ]) {
    assert.equal(Env.STORE_ENV_FILE_VAR in copy, false);
  }
});

test('oneShotSibling: E_ONE_SHOT counts only alongside the sibling markers, and a run of its own drops it', () => {
  for (const name of [
    Env.SPAWN_PARENT_WORKTREE_VAR,
    Env.SPAWN_PARENT_BRANCH_VAR,
    Env.SPAWN_SPOOL_VAR,
    Env.SPAWN_SIBLING_ID_VAR,
  ]) {
    delete process.env[name];
  }
  process.env[Env.ONE_SHOT_VAR] = '1';
  assert.equal(env.oneShotSibling, false, 'a stale export alone');
  process.env[Env.SPAWN_PARENT_WORKTREE_VAR] = '/w';
  process.env[Env.SPAWN_PARENT_BRANCH_VAR] = 'e/pi/x-1';
  process.env[Env.SPAWN_SPOOL_VAR] = '/spool';
  process.env[Env.SPAWN_SIBLING_ID_VAR] = 'sib-001';
  assert.equal(env.oneShotSibling, true);
  process.env[Env.ONE_SHOT_VAR] = '0';
  assert.equal(env.oneShotSibling, false);
  const carrying = { PATH: '/bin', [Env.ONE_SHOT_VAR]: '1' };
  for (const copy of [
    env.withReport({ spoolDir: '/spool', id: 'a2a-001' }, carrying),
    env.withLedger('/x.json', carrying),
  ]) {
    assert.equal(Env.ONE_SHOT_VAR in copy, false);
  }
});

test('provenance markers: undefined when unset, trigger and event together, an error with one', () => {
  for (const name of [Env.TRIGGER_VAR, Env.EVENT_VAR, Env.EVENT_URL_VAR]) {
    delete process.env[name];
  }
  // Through a function: an assertion on `env.provenance` would narrow it.
  const read = (): ProvenanceVars | undefined => env.provenance;
  assert.equal(read(), undefined);
  process.env[Env.TRIGGER_VAR] = 'nightly';
  assert.throws(() => env.provenance, /Incomplete provenance markers/);
  process.env[Env.EVENT_VAR] = 'cron:tick:20260918T0300Z';
  assert.deepEqual(read(), {
    trigger: 'nightly',
    event: 'cron:tick:20260918T0300Z',
  });
  process.env[Env.EVENT_URL_VAR] = 'https://github.com/o/r/issues/1';
  assert.equal(read()?.url, 'https://github.com/o/r/issues/1');
  assert.deepEqual(
    env.provenanceEnv({ trigger: 'nightly', event: 'cron:tick:1' }),
    { [Env.TRIGGER_VAR]: 'nightly', [Env.EVENT_VAR]: 'cron:tick:1' }
  );
});

test('provenance markers never reach a run of its own or a sibling from the ambient environment', () => {
  const carrying = {
    PATH: '/usr/bin',
    [Env.TRIGGER_VAR]: 'nightly',
    [Env.EVENT_VAR]: 'cron:tick:1',
    [Env.EVENT_URL_VAR]: 'https://github.com/o/r',
  };
  for (const copy of [
    env.withReport({ spoolDir: '/spool', id: 'a2a-001' }, carrying),
    env.withLedger('/x.json', carrying),
    env.withSibling(
      {
        parent: { worktreePath: '/wt', branch: 'e/demo/p-1' },
        spoolDir: '/spool',
        id: 'sib-001',
      },
      carrying
    ),
  ]) {
    assert.equal(copy[Env.TRIGGER_VAR], undefined);
    assert.equal(copy[Env.EVENT_VAR], undefined);
    assert.equal(copy[Env.EVENT_URL_VAR], undefined);
    assert.equal(copy.PATH, '/usr/bin');
  }
});
