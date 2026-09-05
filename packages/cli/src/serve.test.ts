import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createServeApp, startServeServer } from './serve';

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
