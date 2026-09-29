import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TriggerListingResponse } from '../../core/trigger/listing.js';
import { createServeApp, startServeServer } from './serveApp.js';

/*
 * `GET /api/triggers` (ADR-0016 section 8): all trigger types, `nextFireAt`
 * from now, the last fire from the queue's memory since serve started.
 */

test('GET /api/triggers: every trigger, its next fire, and the last one the queue remembers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-triggers-api-'));
  const write = (name: string, body: object): void => {
    const dir = path.join(root, '.e', 'triggers', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'trigger.json'), JSON.stringify(body));
  };
  write('nightly', {
    agent: 'pi',
    prompt: 'p',
    on: { type: 'cron', expr: '0 3 * * *' },
  });
  write('broken', {
    agent: 'pi',
    prompt: 'p',
    on: { type: 'cron', expr: '61 * * * *' },
  });
  const app = createServeApp({
    triggers: {
      store: { root, context: () => ({}) },
      queue: {
        startedAt: '2026-09-18T00:00:00.000Z',
        triggerActivity: id =>
          id === 'nightly'
            ? {
                lastFiredAt: '2026-09-17T03:00:04.000Z',
                lastRequestId: 'trg-1',
              }
            : undefined,
      },
      now: () => new Date('2026-09-18T01:00:00Z'),
    },
  });
  const server = await startServeServer(app, '127.0.0.1', 0);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/api/triggers`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as TriggerListingResponse;
    assert.equal(body.store, path.join(root, '.e'));
    assert.equal(body.activitySince, '2026-09-18T00:00:00.000Z');
    const byId = new Map(body.triggers.map(t => [t.id, t]));
    assert.equal(byId.get('nightly')?.nextFireAt, '2026-09-18T03:00:00.000Z');
    assert.equal(byId.get('nightly')?.lastRequestId, 'trg-1');
    assert.match(byId.get('broken')?.error ?? '', /not a schedule/);
    assert.equal(byId.get('broken')?.nextFireAt, null);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/triggers: without a queue the last fire is unknown and says since when nothing is known', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-triggers-api-'));
  const app = createServeApp({
    triggers: { store: { root, context: () => ({}) } },
  });
  const server = await startServeServer(app, '127.0.0.1', 0);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const body = (await (
      await fetch(`http://127.0.0.1:${address.port}/api/triggers`)
    ).json()) as TriggerListingResponse;
    assert.equal(body.activitySince, null);
    assert.deepEqual(body.triggers, []);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("GET /api/triggers: in serve, the next fire is the scheduler's, so a fire about to happen is not reported as tomorrow", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-triggers-api-'));
  const dir = path.join(root, '.e', 'triggers', 'nightly');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'trigger.json'),
    JSON.stringify({
      agent: 'pi',
      prompt: 'p',
      on: { type: 'cron', expr: '0 3 * * *' },
    })
  );
  const app = createServeApp({
    triggers: {
      store: { root, context: () => ({}) },
      // 20 s past 03:00: the scheduler has not ticked yet.
      now: () => new Date('2026-09-18T03:00:20Z'),
      scheduler: {
        nextFireAt: id =>
          id === 'nightly' ? new Date('2026-09-18T03:00:00Z') : undefined,
      },
    },
  });
  const server = await startServeServer(app, '127.0.0.1', 0);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const body = (await (
      await fetch(`http://127.0.0.1:${address.port}/api/triggers`)
    ).json()) as TriggerListingResponse;
    assert.equal(body.triggers[0].nextFireAt, '2026-09-18T03:00:00.000Z');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
