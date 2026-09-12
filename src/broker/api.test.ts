import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createBrokerApi, parseSpawnBody } from './api.js';
import { SseParser } from './events.js';
import {
  hasCancelSignal,
  hasMergeSignal,
  readRequest,
  writeRunInfo,
  writeStatus,
} from './spool.js';
import type {
  CancelAccepted,
  MergeSignalAccepted,
  SiblingRecord,
  SpawnAccepted,
  StatusResponse,
} from './types.js';

interface Fixture {
  url: string;
  spoolDir: string;
  close(): Promise<void>;
}

async function startBroker(): Promise<Fixture> {
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-broker-api-'));
  const server = http.createServer(
    createBrokerApi({
      spoolDir,
      now: () => new Date('2026-09-12T10:00:00.000Z'),
    })
  );
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    spoolDir,
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(spoolDir, { recursive: true, force: true });
    },
  };
}

async function json<T>(res: Response): Promise<T> {
  assert.equal(res.headers.get('content-type'), 'application/json');
  return (await res.json()) as T;
}

function post(url: string, body: string): Promise<Response> {
  return fetch(`${url}/spawn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

test('parseSpawnBody: accepts {agent, prompt}, trimmed; rejects everything else with a reason', () => {
  assert.deepEqual(parseSpawnBody('{"agent":" a ","prompt":" do it "}'), {
    ok: true,
    body: { agent: 'a', prompt: 'do it' },
  });
  assert.match(
    (parseSpawnBody('not json') as { error: string }).error,
    /JSON object/
  );
  assert.match(
    (parseSpawnBody('[1]') as { error: string }).error,
    /JSON object/
  );
  assert.match(
    (parseSpawnBody('{"prompt":"x"}') as { error: string }).error,
    /"agent"/
  );
  assert.match(
    (parseSpawnBody('{"agent":"a","prompt":"  "}') as { error: string }).error,
    /"prompt"/
  );
});

test('broker api: GET /health', async () => {
  const broker = await startBroker();
  try {
    const res = await fetch(`${broker.url}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { status: 'ok' });
  } finally {
    await broker.close();
  }
});

test('broker api: POST /spawn spools the request and answers 202 with its id', async () => {
  const broker = await startBroker();
  try {
    const res = await post(
      broker.url,
      JSON.stringify({ agent: 'researcher', prompt: 'look into X' })
    );
    assert.equal(res.status, 202);
    assert.deepEqual(await json<SpawnAccepted>(res), {
      id: 'sib-001',
      status: 'requested',
      statusPath: '/status/sib-001',
    });
    assert.deepEqual(readRequest(broker.spoolDir, 'sib-001'), {
      id: 'sib-001',
      agent: 'researcher',
      prompt: 'look into X',
      requestedAt: '2026-09-12T10:00:00.000Z',
    });

    const second = await post(
      broker.url,
      JSON.stringify({ agent: 'coder', prompt: 'do Y' })
    );
    assert.equal((await json<SpawnAccepted>(second)).id, 'sib-002');
  } finally {
    await broker.close();
  }
});

test('broker api: POST /spawn rejects malformed bodies with 400 and spools nothing', async () => {
  const broker = await startBroker();
  try {
    for (const body of ['nope', '{"agent":"a"}', '{"agent":"","prompt":"x"}']) {
      const res = await post(broker.url, body);
      assert.equal(res.status, 400, body);
    }
    assert.equal(fs.existsSync(path.join(broker.spoolDir, 'requests')), false);
  } finally {
    await broker.close();
  }
});

test('broker api: an oversized body is refused with 413', async () => {
  const broker = await startBroker();
  try {
    const res = await post(
      broker.url,
      JSON.stringify({ agent: 'a', prompt: 'x'.repeat(70 * 1024) })
    ).catch(() => undefined);
    // The server destroys the socket after 64 KiB; depending on timing the
    // client sees the 413 or a reset connection. Either way nothing is spooled.
    if (res) assert.equal(res.status, 413);
    assert.equal(fs.existsSync(path.join(broker.spoolDir, 'requests')), false);
  } finally {
    await broker.close();
  }
});

test('broker api: GET /status merges the run info and the host status per sibling', async () => {
  const broker = await startBroker();
  try {
    const empty = await json<StatusResponse>(
      await fetch(`${broker.url}/status`)
    );
    assert.deepEqual(empty, { run: null, siblings: [] });

    writeRunInfo(broker.spoolDir, {
      name: 'e-demo-task-1',
      branch: 'e/demo/task-1',
      agent: 'demo',
      role: 'parent',
      maxSiblings: 3,
    });
    await post(broker.url, JSON.stringify({ agent: 'a', prompt: 'one' }));
    await post(broker.url, JSON.stringify({ agent: 'b', prompt: 'two' }));
    writeStatus(broker.spoolDir, 'sib-001', {
      status: 'running',
      branch: 'e/a/one-1',
      updatedAt: 't1',
    });

    const status = await json<StatusResponse>(
      await fetch(`${broker.url}/status`)
    );
    assert.equal(status.run?.name, 'e-demo-task-1');
    assert.deepEqual(
      status.siblings.map(s => [s.id, s.status, s.branch]),
      [
        ['sib-001', 'running', 'e/a/one-1'],
        ['sib-002', 'requested', undefined],
      ]
    );

    const one = await fetch(`${broker.url}/status/sib-002`);
    assert.equal(one.status, 200);
    assert.equal((await json<SiblingRecord>(one)).prompt, 'two');
  } finally {
    await broker.close();
  }
});

test('broker api: unknown siblings, malformed ids, unknown paths and wrong methods', async () => {
  const broker = await startBroker();
  try {
    assert.equal((await fetch(`${broker.url}/status/sib-999`)).status, 404);
    assert.equal(
      (await fetch(`${broker.url}/status/${encodeURIComponent('../run')}`))
        .status,
      404
    );
    assert.equal((await fetch(`${broker.url}/nope`)).status, 404);
    assert.equal((await fetch(`${broker.url}/spawn`)).status, 405);
    assert.equal(
      (await fetch(`${broker.url}/status`, { method: 'POST' })).status,
      405
    );
  } finally {
    await broker.close();
  }
});

test('broker api: a spool whose run is itself a sibling refuses every request (depth limit)', async () => {
  const broker = await startBroker();
  try {
    writeRunInfo(broker.spoolDir, {
      name: 'e-demo-sib-1',
      branch: 'e/demo/sib-1',
      agent: 'demo',
      role: 'child',
      maxSiblings: 3,
    });
    const res = await post(
      broker.url,
      JSON.stringify({ agent: 'a', prompt: 'x' })
    );
    assert.equal(res.status, 403);
    assert.match((await json<{ error: string }>(res)).error, /Depth limit/);
    assert.equal(fs.existsSync(path.join(broker.spoolDir, 'requests')), false);
  } finally {
    await broker.close();
  }
});

test('broker api: the fan-out cap counts requests in flight and frees up when one finishes', async () => {
  const broker = await startBroker();
  try {
    writeRunInfo(broker.spoolDir, {
      name: 'e-demo-task-1',
      branch: 'e/demo/task-1',
      agent: 'demo',
      role: 'parent',
      maxSiblings: 1,
    });
    const first = await post(
      broker.url,
      JSON.stringify({ agent: 'a', prompt: 'one' })
    );
    assert.equal(first.status, 202);
    // Still `requested` (not yet picked up) counts against the cap.
    const second = await post(
      broker.url,
      JSON.stringify({ agent: 'b', prompt: 'two' })
    );
    assert.equal(second.status, 429);
    assert.match(
      (await json<{ error: string }>(second)).error,
      /Sibling cap reached \(1 in flight\)/
    );
    writeStatus(broker.spoolDir, 'sib-001', {
      status: 'done',
      exitCode: 0,
      updatedAt: 't',
    });
    const third = await post(
      broker.url,
      JSON.stringify({ agent: 'b', prompt: 'two' })
    );
    assert.equal(third.status, 202);
    assert.equal((await json<SpawnAccepted>(third)).id, 'sib-002');
  } finally {
    await broker.close();
  }
});

test('broker api: POST /merge/<id> spools the parent signal for a held or conflicted merge-back only', async () => {
  const broker = await startBroker();
  try {
    await post(broker.url, JSON.stringify({ agent: 'a', prompt: 'one' }));
    await post(broker.url, JSON.stringify({ agent: 'b', prompt: 'two' }));
    await post(broker.url, JSON.stringify({ agent: 'c', prompt: 'three' }));
    const signal = (id: string) =>
      fetch(`${broker.url}/merge/${id}`, { method: 'POST' });

    // Unknown, malformed, wrong method.
    assert.equal((await signal('sib-999')).status, 404);
    assert.equal((await signal('..%2Fx')).status, 404);
    assert.equal(
      (await fetch(`${broker.url}/merge/sib-001`, { method: 'GET' })).status,
      405
    );

    // Nothing to retry yet (still running), nor once merged.
    writeStatus(broker.spoolDir, 'sib-001', {
      status: 'running',
      branch: 'e/a/one-1',
      updatedAt: 't',
    });
    const running = await signal('sib-001');
    assert.equal(running.status, 409);
    assert.match(
      (await json<{ error: string }>(running)).error,
      /Nothing to retry for sib-001: its merge-back is not started/
    );
    writeStatus(broker.spoolDir, 'sib-001', {
      status: 'done',
      branch: 'e/a/one-1',
      exitCode: 0,
      merge: { status: 'merged' },
      updatedAt: 't',
    });
    assert.equal((await signal('sib-001')).status, 409);
    assert.equal(hasMergeSignal(broker.spoolDir, 'sib-001'), false);

    // Held over files in the way, or in progress with conflict markers: the
    // signal is spooled and the caller is pointed back at the status.
    writeStatus(broker.spoolDir, 'sib-002', {
      status: 'done',
      branch: 'e/b/two-1',
      exitCode: 0,
      merge: { status: 'held', files: ['src/a.ts'], reason: 'in flight' },
      updatedAt: 't',
    });
    writeStatus(broker.spoolDir, 'sib-003', {
      status: 'done',
      branch: 'e/c/three-1',
      exitCode: 0,
      merge: { status: 'conflict', files: ['src/b.ts'] },
      updatedAt: 't',
    });
    const held = await signal('sib-002');
    assert.equal(held.status, 202);
    assert.deepEqual(await json<MergeSignalAccepted>(held), {
      id: 'sib-002',
      status: 'merge-requested',
      statusPath: '/status/sib-002',
    });
    assert.equal((await signal('sib-003')).status, 202);
    assert.equal(hasMergeSignal(broker.spoolDir, 'sib-002'), true);
    assert.equal(hasMergeSignal(broker.spoolDir, 'sib-003'), true);
    // The merge state rides the status the agent polls.
    const record = await json<SiblingRecord>(
      await fetch(`${broker.url}/status/sib-003`)
    );
    assert.deepEqual(record.merge, { status: 'conflict', files: ['src/b.ts'] });
  } finally {
    await broker.close();
  }
});

test('broker api: POST /cancel/<id> spools a cancel for a request the host is not done with; a settled one is 409', async () => {
  const broker = await startBroker();
  try {
    await post(broker.url, JSON.stringify({ agent: 'a', prompt: 'one' }));
    await post(broker.url, JSON.stringify({ agent: 'b', prompt: 'two' }));
    await post(broker.url, JSON.stringify({ agent: 'c', prompt: 'three' }));
    const cancel = (id: string) =>
      fetch(`${broker.url}/cancel/${id}`, { method: 'POST' });

    assert.equal((await cancel('sib-999')).status, 404);
    assert.equal((await cancel('..%2Fx')).status, 404);
    assert.equal(
      (await fetch(`${broker.url}/cancel/sib-001`, { method: 'GET' })).status,
      405
    );

    // Not yet picked up: cancelable (the host marks it canceled on its tick).
    const waiting = await cancel('sib-001');
    assert.equal(waiting.status, 202);
    assert.deepEqual(await json<CancelAccepted>(waiting), {
      id: 'sib-001',
      status: 'cancel-requested',
      statusPath: '/status/sib-001',
    });
    assert.equal(hasCancelSignal(broker.spoolDir, 'sib-001'), true);

    // Running: cancelable.
    writeStatus(broker.spoolDir, 'sib-002', {
      status: 'running',
      branch: 'e/b/two-1',
      updatedAt: 't',
    });
    assert.equal((await cancel('sib-002')).status, 202);

    // Done, failed, canceled, rejected: nothing to cancel.
    for (const status of ['done', 'failed', 'canceled', 'rejected'] as const) {
      writeStatus(broker.spoolDir, 'sib-003', { status, updatedAt: 't' });
      const settled = await cancel('sib-003');
      assert.equal(settled.status, 409, status);
      assert.match(
        (await json<{ error: string }>(settled)).error,
        new RegExp(`already ${status}`)
      );
    }
    assert.equal(hasCancelSignal(broker.spoolDir, 'sib-003'), false);
  } finally {
    await broker.close();
  }
});

test('broker api: GET /status carries the A2A taskState per sibling', async () => {
  const broker = await startBroker();
  try {
    await post(broker.url, JSON.stringify({ agent: 'a', prompt: 'one' }));
    await post(broker.url, JSON.stringify({ agent: 'b', prompt: 'two' }));
    writeStatus(broker.spoolDir, 'sib-002', {
      status: 'done',
      branch: 'e/b/two-1',
      exitCode: 0,
      merge: { status: 'held', files: ['x'], reason: 'in flight' },
      updatedAt: 't',
    });
    const status = await json<StatusResponse>(
      await fetch(`${broker.url}/status`)
    );
    assert.deepEqual(
      status.siblings.map(s => [s.id, s.taskState]),
      [
        ['sib-001', 'submitted'],
        ['sib-002', 'input-required'],
      ]
    );
  } finally {
    await broker.close();
  }
});

test('broker api: GET /status/events streams the status as server-sent events, one per change', async () => {
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-broker-api-'));
  const server = http.createServer(
    createBrokerApi({ spoolDir, eventsPollMs: 5, eventsHeartbeatMs: 1000 })
  );
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(
      (await fetch(`${url}/status/events`, { method: 'POST' })).status,
      405
    );
    const response = await fetch(`${url}/status/events`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const reader = response.body!.getReader();
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const events: StatusResponse[] = [];
    const next = async (): Promise<void> => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        const parsed = parser.push(decoder.decode(value, { stream: true }));
        if (parsed.length === 0) continue;
        for (const event of parsed) {
          assert.equal(event.event, 'status');
          events.push(JSON.parse(event.data) as StatusResponse);
        }
        return;
      }
    };
    await next();
    assert.deepEqual(events[0], { run: null, siblings: [] });
    await post(url, JSON.stringify({ agent: 'a', prompt: 'one' }));
    await next();
    assert.deepEqual(
      events[1].siblings.map(s => [s.id, s.status, s.taskState]),
      [['sib-001', 'requested', 'submitted']]
    );
    writeStatus(spoolDir, 'sib-001', {
      status: 'done',
      exitCode: 0,
      updatedAt: 't',
    });
    await next();
    assert.equal(events[2].siblings[0].taskState, 'completed');
    await reader.cancel();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(spoolDir, { recursive: true, force: true });
  }
});
