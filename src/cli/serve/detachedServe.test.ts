import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  detachedServeArguments,
  ensureDetachedServe,
  isServeStateLive,
  shouldReuseDetachedServe,
  startDetachedServe,
  type DetachedChild,
  type ServeState,
} from './detachedServe.js';

/** A spawned child that never really starts: the test decides when it fails. */
function fakeChild(): {
  handle: DetachedChild;
  fail: (error: Error) => void;
  unrefs: () => number;
} {
  let onError: ((error: Error) => void) | undefined;
  let unrefs = 0;
  return {
    handle: {
      once: (_event: 'error', listener: (error: Error) => void) => {
        onError = listener;
        return undefined;
      },
      unref: () => {
        unrefs += 1;
      },
    },
    fail: error => onError?.(error),
    unrefs: () => unrefs,
  };
}

test('detachedServeArguments preserves command arguments and removes detached flags', () => {
  assert.deepEqual(
    detachedServeArguments([
      '/usr/bin/node',
      '/workspace/dist/index.js',
      'serve',
      '--detached',
      '--host',
      '0.0.0.0',
      '-d',
      '--port',
      '8080',
    ]),
    ['/workspace/dist/index.js', 'serve', '--host', '0.0.0.0', '--port', '8080']
  );
});

test('detachedServeArguments drops the snapshot entry path in a single-executable', () => {
  // In a pkg --sea binary argv[1] is the embedded entry, which the executable
  // runs by itself; passing it again would be taken for an unknown command.
  assert.deepEqual(
    detachedServeArguments(
      [
        '/usr/local/bin/e',
        '/snapshot/e/dist/index.js',
        'serve',
        '-d',
        '--port',
        '9000',
      ],
      true
    ),
    ['serve', '--port', '9000']
  );
});

test('isServeStateLive: a dead pid makes the entry stale', async () => {
  const stale: ServeState = { pid: 999_999, host: '127.0.0.1', port: 8080 };
  const result = await isServeStateLive(stale, {
    isAlive: () => false,
    probeHealth: async () => {
      throw new Error('probe must not run when the pid is dead');
    },
  });
  assert.equal(result, false);
});

test('isServeStateLive: a live pid but unresponsive health check is stale in effect', async () => {
  const state: ServeState = { pid: 1234, host: '127.0.0.1', port: 8080 };
  let probedUrl = '';
  const result = await isServeStateLive(state, {
    isAlive: () => true,
    probeHealth: async url => {
      probedUrl = url;
      return false;
    },
  });
  assert.equal(result, false);
  assert.equal(probedUrl, 'http://127.0.0.1:8080/api/health');
});

test('isServeStateLive: live pid and answering health check mean serving', async () => {
  const state: ServeState = { pid: 1234, host: '127.0.0.1', port: 8080 };
  const result = await isServeStateLive(state, {
    isAlive: () => true,
    probeHealth: async () => true,
  });
  assert.equal(result, true);
});

test('shouldReuseDetachedServe: no recorded entry falls through to a fresh start', async () => {
  const result = await shouldReuseDetachedServe(undefined);
  assert.equal(result, false);
});

test('shouldReuseDetachedServe: a stale entry falls through to a fresh start', async () => {
  const stale: ServeState = { pid: 999_999, host: '127.0.0.1', port: 8080 };
  const result = await shouldReuseDetachedServe(stale, {
    isAlive: () => false,
  });
  assert.equal(result, false);
});

test('shouldReuseDetachedServe: a live entry short-circuits to already serving', async () => {
  const state: ServeState = { pid: 1234, host: '127.0.0.1', port: 8080 };
  const result = await shouldReuseDetachedServe(state, {
    isAlive: () => true,
    probeHealth: async () => true,
  });
  assert.equal(result, true);
});

test('ensureDetachedServe: a verified-live entry is reused, nothing is spawned or cleared', async () => {
  const live: ServeState = { pid: 1234, host: '127.0.0.1', port: 8080 };
  const outcome = await ensureDetachedServe({
    readState: () => live,
    isAlive: () => true,
    probeHealth: async () => true,
    clearState: () => assert.fail('a live entry must not be cleared'),
    spawnChild: () => assert.fail('a live server must not be respawned'),
  });
  assert.deepEqual(outcome, { reused: true, state: live });
});

test('ensureDetachedServe: a stale entry is cleared and a fresh child respawned', async () => {
  // What a reboot leaves behind: the file survived, the process did not.
  let recorded: ServeState | undefined = {
    pid: 999_999,
    host: '127.0.0.1',
    port: 8080,
  };
  let cleared = 0;
  const child = fakeChild();
  const outcome = await ensureDetachedServe({
    readState: () => recorded,
    isAlive: () => false,
    clearState: () => {
      cleared += 1;
      recorded = undefined;
    },
    spawnChild: () => {
      // The real child records itself once its listener is up.
      recorded = { pid: 4242, host: '127.0.0.1', port: 8080 };
      return child.handle;
    },
    pollMs: 1,
    readyTimeoutMs: 1000,
  });
  assert.deepEqual(outcome, { reused: false, clearedStale: true });
  assert.equal(cleared, 1);
  assert.equal(child.unrefs(), 1, 'the child must not hold the parent open');
});

test('ensureDetachedServe: no recorded entry starts a child without clearing anything', async () => {
  let recorded: ServeState | undefined = undefined;
  const child = fakeChild();
  const outcome = await ensureDetachedServe({
    readState: () => recorded,
    clearState: () => assert.fail('there is no entry to clear'),
    spawnChild: () => {
      recorded = { pid: 7, host: '127.0.0.1', port: 8080 };
      return child.handle;
    },
    pollMs: 1,
    readyTimeoutMs: 1000,
  });
  assert.deepEqual(outcome, { reused: false, clearedStale: false });
});

test('startDetachedServe: a spawn failure is reported as itself, not as the readiness timeout', async () => {
  const child = fakeChild();
  const started = startDetachedServe({
    readState: () => undefined,
    spawnChild: () => child.handle,
    pollMs: 5,
    // Long enough that a timeout would outlive the test: the spawn error has
    // to be what rejects, and it has to stop the poll.
    readyTimeoutMs: 60_000,
  });
  child.fail(new Error('spawn ENOENT'));
  await assert.rejects(started, {
    message: 'Could not start the detached UI server: spawn ENOENT',
  });
});

test('startDetachedServe: a child that never records an entry times out', async () => {
  const child = fakeChild();
  await assert.rejects(
    startDetachedServe({
      readState: () => undefined,
      spawnChild: () => child.handle,
      pollMs: 1,
      readyTimeoutMs: 20,
    }),
    { message: 'Detached UI server did not become ready' }
  );
});
