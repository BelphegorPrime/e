import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Env, env } from './env.js';

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
  Env.A2A_TOKEN_VAR,
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

test('a2aToken is the trimmed E_A2A_TOKEN, undefined when unset or blank', () => {
  delete process.env[Env.A2A_TOKEN_VAR];
  assert.equal(env.a2aToken, undefined);
  process.env[Env.A2A_TOKEN_VAR] = '  ';
  assert.equal(env.a2aToken, undefined);
  process.env[Env.A2A_TOKEN_VAR] = ' secret ';
  assert.equal(env.a2aToken, 'secret');
});
