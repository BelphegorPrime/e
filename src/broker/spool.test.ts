import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureSpool,
  isRequestId,
  listRecords,
  listRequestIds,
  nextRequestId,
  readRecord,
  readRunInfo,
  readStatus,
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

test('isRequestId: sib-NNN only, so an id is safe to use as a file name', () => {
  assert.equal(isRequestId('sib-001'), true);
  assert.equal(isRequestId('sib-1234'), true);
  assert.equal(isRequestId('sib-1'), false);
  assert.equal(isRequestId('../etc/passwd'), false);
  assert.equal(isRequestId('sib-001.json'), false);
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
