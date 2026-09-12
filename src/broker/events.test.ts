import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SseParser, formatSseEvent, streamStatusEvents } from './events.js';
import { attentionSince } from './watch.js';
import type { SiblingRecord } from './types.js';

test('formatSseEvent: one event name, one JSON data line, a blank line', () => {
  assert.equal(
    formatSseEvent('status', { a: 1 }),
    'event: status\ndata: {"a":1}\n\n'
  );
});

test('SseParser: splits chunks into events, joins multi-line data, drops comments, defaults the event name', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push('event: status\ndata: {"a":'), []);
  assert.deepEqual(parser.push('1}\n\n: keep-alive\n\ndata: x\ndata: y\n\n'), [
    { event: 'status', data: '{"a":1}' },
    { event: 'message', data: 'x\ny' },
  ]);
  assert.deepEqual(parser.push('data:no-space\r\n\r\n'), [
    { event: 'message', data: 'no-space' },
  ]);
});

/** Reads the SSE body until `count` events arrived (or the stream ends). */
async function readEvents(
  response: Response,
  count: number
): Promise<Array<{ event: string; data: string }>> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: string }> = [];
  const reader = response.body!.getReader();
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    events.push(...parser.push(decoder.decode(value, { stream: true })));
  }
  await reader.cancel();
  return events;
}

test('streamStatusEvents: sends the snapshot at once, then only on change; stops when the client goes away', async () => {
  let snapshot: unknown = { n: 1 };
  let stops = 0;
  const server = http.createServer((req, res) => {
    const stop = streamStatusEvents(req, res, {
      snapshot: () => snapshot,
      pollMs: 5,
      heartbeatMs: 20,
    });
    req.on('close', () => {
      stop();
      stops += 1;
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const first = await readEvents(response, 1);
    assert.deepEqual(first, [{ event: 'status', data: '{"n":1}' }]);

    const second = fetch(`http://127.0.0.1:${port}/`).then(res => {
      // Change the snapshot after the first event has gone out.
      setTimeout(() => {
        snapshot = { n: 2 };
      }, 10);
      return readEvents(res, 2);
    });
    assert.deepEqual(await second, [
      { event: 'status', data: '{"n":1}' },
      { event: 'status', data: '{"n":2}' },
    ]);
    // Both clients cancelled their bodies: both streams stopped.
    const deadline = Date.now() + 2000;
    while (stops < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(stops, 2);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('streamStatusEvents: a snapshot that throws becomes an error event, not a dead stream', async () => {
  const server = http.createServer((req, res) => {
    streamStatusEvents(req, res, {
      snapshot: () => {
        throw new Error('spool unreadable');
      },
      pollMs: 5,
      heartbeatMs: 20,
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    const events = await readEvents(
      await fetch(`http://127.0.0.1:${port}/`),
      1
    );
    assert.deepEqual(JSON.parse(events[0].data), { error: 'spool unreadable' });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

const record = (
  id: string,
  taskState: SiblingRecord['taskState']
): SiblingRecord => ({
  id,
  agent: 'a',
  prompt: 'p',
  requestedAt: 't',
  status: 'running',
  taskState,
});

test('attentionSince (--watch): reports what already needs attention on the first snapshot, then only what newly does', () => {
  // First snapshot: sib-001 is already done, sib-002 still working.
  const first = [record('sib-001', 'completed'), record('sib-002', 'working')];
  assert.deepEqual(
    attentionSince(undefined, first).map(r => r.id),
    ['sib-001']
  );
  // Nothing new: the completed one does not fire again.
  assert.deepEqual(attentionSince(first, first), []);
  // sib-002 reaches input-required: that is the news.
  const later = [
    record('sib-001', 'completed'),
    record('sib-002', 'input-required'),
  ];
  assert.deepEqual(
    attentionSince(first, later).map(r => r.id),
    ['sib-002']
  );
  // A working -> working change is not news; a new sibling appearing in
  // `working` is not either.
  assert.deepEqual(
    attentionSince(first, [...first, record('sib-003', 'working')]),
    []
  );
});

test('attentionSince (--watch <id>): only the named sibling counts', () => {
  const first = [record('sib-001', 'working'), record('sib-002', 'working')];
  const later = [record('sib-001', 'failed'), record('sib-002', 'completed')];
  assert.deepEqual(
    attentionSince(first, later, 'sib-002').map(r => r.id),
    ['sib-002']
  );
  assert.deepEqual(attentionSince(undefined, first, 'sib-002'), []);
  assert.deepEqual(
    attentionSince(undefined, later, 'sib-002').map(r => r.id),
    ['sib-002']
  );
});
