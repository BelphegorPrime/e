import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createServeApp,
  detachedServeArguments,
  isServeStateLive,
  shouldReuseDetachedServe,
  startServeServer,
  type ServeState,
} from './serve';
import type { ModelsResponse } from './modelStatus';

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

test('serve app exposes API routes and the UI fallback', async () => {
  const uiDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'e-ui-'));
  await fs.writeFile(
    path.join(uiDirectory, 'index.html'),
    '<!doctype html><title>e</title>'
  );

  const server = await startServeServer(
    createServeApp(uiDirectory),
    '127.0.0.1',
    0
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const info = await fetch(`${baseUrl}/api/info`);
    assert.equal(info.status, 200);
    assert.deepEqual(await info.json(), { name: 'e', version: '1.0.0' });

    const page = await fetch(`${baseUrl}/projects/current`);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), '<!doctype html><title>e</title>');

    const missingApi = await fetch(`${baseUrl}/api/missing`);
    assert.equal(missingApi.status, 404);
    assert.deepEqual(await missingApi.json(), { error: 'Not found' });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
    await fs.rm(uiDirectory, { recursive: true, force: true });
  }
});

test('serve app exposes llama.cpp model status via /api/omniroute/models', async () => {
  const uiDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'e-ui-'));
  await fs.writeFile(
    path.join(uiDirectory, 'index.html'),
    '<!doctype html><title>e</title>'
  );
  const models: ModelsResponse = {
    data: [
      {
        id: 'org/model-a',
        status: {
          value: 'downloading',
          progress: { url: { done: 500, total: 1000 } },
        },
      },
    ],
  };
  const server = await startServeServer(
    createServeApp(uiDirectory, {
      llamaBaseUrl: 'http://llama-fake',
      fetchImpl: (async (input: string | URL | Request) => {
        assert.equal(String(input), 'http://llama-fake/models');
        return {
          ok: true,
          status: 200,
          json: async () => models,
        } as unknown as Response;
      }) as typeof fetch,
    }),
    '127.0.0.1',
    0
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const res = await fetch(`${baseUrl}/api/omniroute/models`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), models);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
    await fs.rm(uiDirectory, { recursive: true, force: true });
  }
});

test('serve app reports 503 when the llama.cpp stack is unreachable', async () => {
  const uiDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'e-ui-'));
  await fs.writeFile(
    path.join(uiDirectory, 'index.html'),
    '<!doctype html><title>e</title>'
  );
  const server = await startServeServer(
    createServeApp(uiDirectory, {
      llamaBaseUrl: 'http://llama-fake',
      fetchImpl: (async () => {
        throw new Error('connection refused');
      }) as typeof fetch,
    }),
    '127.0.0.1',
    0
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const res = await fetch(`${baseUrl}/api/omniroute/models`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), {
      error: 'llama.cpp stack is not running',
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
    await fs.rm(uiDirectory, { recursive: true, force: true });
  }
});

test('serve app reports 502 when llama.cpp answers with a non-OK status', async () => {
  const uiDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'e-ui-'));
  await fs.writeFile(
    path.join(uiDirectory, 'index.html'),
    '<!doctype html><title>e</title>'
  );
  const server = await startServeServer(
    createServeApp(uiDirectory, {
      llamaBaseUrl: 'http://llama-fake',
      fetchImpl: (async () =>
        ({ ok: false, status: 500 }) as unknown as Response) as typeof fetch,
    }),
    '127.0.0.1',
    0
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const res = await fetch(`${baseUrl}/api/omniroute/models`);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), {
      error: 'llama.cpp returned HTTP 500',
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
    await fs.rm(uiDirectory, { recursive: true, force: true });
  }
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
