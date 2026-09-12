import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  countInFlight,
  ensureSpool,
  hasCancelSignal,
  hasMergeSignal,
  isRequestId,
  listRecords,
  listRequestIds,
  nextRequestId,
  readRecord,
  readRunInfo,
  readStatus,
  signalCancel,
  signalMerge,
  takeCancelSignal,
  takeMergeSignal,
  writeRequest,
  writeRunInfo,
  writeStatus,
} from './spool.js';

function withSpool<T>(fn: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-broker-spool-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const request = (id: string) => ({
  id,
  agent: 'researcher',
  prompt: 'look into X',
  requestedAt: '2026-09-12T10:00:00.000Z',
});

test('isRequestId: sib-NNN (a sibling) or a2a-NNN (an A2A task) only, so an id is safe to use as a file name', () => {
  assert.equal(isRequestId('sib-001'), true);
  assert.equal(isRequestId('sib-1234'), true);
  assert.equal(isRequestId('a2a-001'), true);
  assert.equal(isRequestId('sib-1'), false);
  assert.equal(isRequestId('task-001'), false);
  assert.equal(isRequestId('../etc/passwd'), false);
  assert.equal(isRequestId('sib-001.json'), false);
});

test("nextRequestId counts per prefix: A2A tasks and siblings never take each other's numbers", () => {
  withSpool(root => {
    ensureSpool(root);
    assert.equal(nextRequestId(root, 'a2a'), 'a2a-001');
    writeRequest(root, request('sib-001'));
    writeRequest(root, request('sib-002'));
    assert.equal(nextRequestId(root, 'a2a'), 'a2a-001');
    writeRequest(root, request('a2a-001'));
    assert.equal(nextRequestId(root, 'a2a'), 'a2a-002');
    assert.equal(nextRequestId(root), 'sib-003');
    assert.deepEqual(listRequestIds(root), ['a2a-001', 'sib-001', 'sib-002']);
  });
});

test('ensureSpool creates the requests and status dirs, idempotently', () => {
  withSpool(root => {
    ensureSpool(root);
    ensureSpool(root);
    assert.ok(fs.statSync(path.join(root, 'requests')).isDirectory());
    assert.ok(fs.statSync(path.join(root, 'status')).isDirectory());
  });
});

test('ids are assigned in sequence from the spooled requests', () => {
  withSpool(root => {
    ensureSpool(root);
    assert.equal(nextRequestId(root), 'sib-001');
    writeRequest(root, request('sib-001'));
    assert.equal(nextRequestId(root), 'sib-002');
    writeRequest(root, request('sib-007'));
    assert.equal(nextRequestId(root), 'sib-008');
    assert.deepEqual(listRequestIds(root), ['sib-001', 'sib-007']);
  });
});

test('listRequestIds ignores files that are not requests', () => {
  withSpool(root => {
    ensureSpool(root);
    fs.writeFileSync(path.join(root, 'requests', 'notes.txt'), 'x');
    fs.writeFileSync(path.join(root, 'requests', 'sib-002.json.tmp'), '{}');
    writeRequest(root, request('sib-002'));
    assert.deepEqual(listRequestIds(root), ['sib-002']);
  });
});

test('listRequestIds on a spool without a requests dir is empty', () => {
  withSpool(root => {
    assert.deepEqual(listRequestIds(root), []);
    assert.equal(nextRequestId(root), 'sib-001');
  });
});

test('writeRequest refuses a duplicate id and a malformed id', () => {
  withSpool(root => {
    ensureSpool(root);
    writeRequest(root, request('sib-001'));
    assert.throws(
      () => writeRequest(root, request('sib-001')),
      /already exists/
    );
    assert.throws(
      () => writeRequest(root, request('bogus')),
      /Invalid request id/
    );
  });
});

test('a record is the request plus the host status; requested until the host writes one', () => {
  withSpool(root => {
    ensureSpool(root);
    writeRequest(root, request('sib-001'));
    assert.deepEqual(readRecord(root, 'sib-001'), {
      ...request('sib-001'),
      status: 'requested',
      taskState: 'submitted',
    });
    writeStatus(root, 'sib-001', {
      status: 'done',
      branch: 'e/researcher/look-into-x-1',
      exitCode: 0,
      updatedAt: '2026-09-12T10:05:00.000Z',
    });
    assert.deepEqual(readRecord(root, 'sib-001'), {
      ...request('sib-001'),
      status: 'done',
      taskState: 'completed',
      branch: 'e/researcher/look-into-x-1',
      exitCode: 0,
      updatedAt: '2026-09-12T10:05:00.000Z',
    });
    assert.equal(readRecord(root, 'sib-002'), undefined);
    assert.equal(readStatus(root, '../x'), undefined);
    assert.throws(
      () => writeStatus(root, '../x', { status: 'failed', updatedAt: 'now' }),
      /Invalid request id/
    );
  });
});

test('listRecords returns every request in order with its status', () => {
  withSpool(root => {
    ensureSpool(root);
    writeRequest(root, request('sib-002'));
    writeRequest(root, request('sib-001'));
    writeStatus(root, 'sib-002', { status: 'running', updatedAt: 't' });
    assert.deepEqual(
      listRecords(root).map(r => [r.id, r.status]),
      [
        ['sib-001', 'requested'],
        ['sib-002', 'running'],
      ]
    );
  });
});

test('run info: null until the host writes it, then round-trips', () => {
  withSpool(root => {
    assert.equal(readRunInfo(root), null);
    const info = {
      name: 'e-demo-task-1',
      branch: 'e/demo/task-1',
      agent: 'demo',
      role: 'parent' as const,
      maxSiblings: 3,
    };
    writeRunInfo(root, info);
    assert.deepEqual(readRunInfo(root), info);
    // Atomic write: no temp file is left behind.
    assert.deepEqual(
      fs.readdirSync(root).filter(f => f.endsWith('.tmp')),
      []
    );
  });
});

test('countInFlight counts the requests in the given states', () => {
  withSpool(root => {
    ensureSpool(root);
    writeRequest(root, request('sib-001'));
    writeRequest(root, request('sib-002'));
    writeRequest(root, request('sib-003'));
    writeStatus(root, 'sib-002', { status: 'running', updatedAt: 't' });
    writeStatus(root, 'sib-003', {
      status: 'done',
      exitCode: 0,
      updatedAt: 't',
    });
    assert.equal(countInFlight(root, ['requested', 'starting', 'running']), 2);
    assert.equal(countInFlight(root, ['starting', 'running']), 1);
    assert.equal(countInFlight(root, ['done']), 1);
  });
});

test('merge signals (ticket 07): written once, seen, taken exactly once; a malformed id is refused', () => {
  withSpool(root => {
    ensureSpool(root);
    assert.equal(hasMergeSignal(root, 'sib-001'), false);
    assert.equal(takeMergeSignal(root, 'sib-001'), false);

    signalMerge(root, 'sib-001', '2026-09-12T10:00:00.000Z');
    assert.equal(hasMergeSignal(root, 'sib-001'), true);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(path.join(root, 'signals', 'sib-001.json'), 'utf8')
      ),
      { id: 'sib-001', signaledAt: '2026-09-12T10:00:00.000Z' }
    );
    // Taking consumes it: the host retries once per signal.
    assert.equal(takeMergeSignal(root, 'sib-001'), true);
    assert.equal(hasMergeSignal(root, 'sib-001'), false);
    assert.equal(takeMergeSignal(root, 'sib-001'), false);

    assert.throws(() => signalMerge(root, '../x', 't'), /Invalid request id/);
    assert.equal(hasMergeSignal(root, '../x'), false);
  });
});

test('cancel signals (ADR-0015): their own directory, written once, taken exactly once, apart from merge signals', () => {
  withSpool(root => {
    ensureSpool(root);
    assert.equal(hasCancelSignal(root, 'sib-001'), false);
    assert.equal(takeCancelSignal(root, 'sib-001'), false);

    signalCancel(root, 'sib-001', '2026-09-12T10:00:00.000Z');
    assert.equal(hasCancelSignal(root, 'sib-001'), true);
    assert.equal(hasMergeSignal(root, 'sib-001'), false);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(path.join(root, 'cancels', 'sib-001.json'), 'utf8')
      ),
      { id: 'sib-001', signaledAt: '2026-09-12T10:00:00.000Z' }
    );
    assert.equal(takeCancelSignal(root, 'sib-001'), true);
    assert.equal(hasCancelSignal(root, 'sib-001'), false);
    assert.equal(takeCancelSignal(root, 'sib-001'), false);
    assert.throws(() => signalCancel(root, '../x', 't'), /Invalid request id/);
  });
});

test('every record carries its A2A task state, derived from run state and merge-back', () => {
  withSpool(root => {
    ensureSpool(root);
    for (const id of ['sib-001', 'sib-002', 'sib-003', 'sib-004', 'sib-005']) {
      writeRequest(root, request(id));
    }
    writeStatus(root, 'sib-002', { status: 'running', updatedAt: 't' });
    writeStatus(root, 'sib-003', {
      status: 'done',
      exitCode: 0,
      merge: { status: 'conflict', files: ['a'] },
      updatedAt: 't',
    });
    writeStatus(root, 'sib-004', { status: 'canceled', updatedAt: 't' });
    writeStatus(root, 'sib-005', { status: 'rejected', updatedAt: 't' });
    assert.deepEqual(
      listRecords(root).map(record => [record.id, record.taskState]),
      [
        ['sib-001', 'submitted'],
        ['sib-002', 'working'],
        ['sib-003', 'input-required'],
        ['sib-004', 'canceled'],
        ['sib-005', 'rejected'],
      ]
    );
  });
});
