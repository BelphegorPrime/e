import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimRequest,
  ensureRunsDirs,
  enqueueRequest,
  expireQueue,
  isRunRequestId,
  keyFileName,
  ledgerFile,
  listLedger,
  listQueue,
  newRequestId,
  patchLedgerFile,
  readLedgerEntry,
  runsDirs,
  sweepLedger,
  writeLedgerEntry,
  type RunRequest,
  type RunsDirs,
} from './runsSpool.js';

async function withDirs<T>(fn: (dirs: RunsDirs) => Promise<T> | T) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'e-runs-'));
  try {
    const dirs = runsDirs(store);
    ensureRunsDirs(dirs);
    return await fn(dirs);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
}

function request(key: string, overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    id: newRequestId(),
    key,
    trigger: key.split(':')[0],
    agent: 'pi',
    prompt: 'Fix issue 42',
    enqueuedAt: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
}

test('newRequestId: trg-<ulid>, monotonic within one millisecond', () => {
  const ids = Array.from({ length: 50 }, () => newRequestId());
  for (const id of ids) assert.ok(isRunRequestId(id), id);
  assert.deepEqual([...ids].sort(), ids);
  assert.ok(isRunRequestId(newRequestId('man')));
  assert.equal(isRunRequestId('trg-../../etc'), false);
});

test('keyFileName: filename-safe and collision-free', () => {
  assert.equal(
    keyFileName('nightly:20260918T0300Z'),
    'nightly%3A20260918T0300Z.json'
  );
  assert.notEqual(keyFileName('a:b'), keyFileName('a_b'));
  assert.equal(keyFileName('x/../y').includes('/'), false);
});

test('enqueue: a pending key cannot be enqueued twice; once claimed, the key is free again', () =>
  withDirs(dirs => {
    const first = request('fix-issues:42');
    assert.equal(enqueueRequest(dirs, first, 10).status, 'enqueued');
    assert.equal(
      enqueueRequest(dirs, request('fix-issues:42'), 10).status,
      'duplicate'
    );
    assert.deepEqual(
      listQueue(dirs).map(r => r.id),
      [first.id]
    );

    const claimed = claimRequest(dirs, 'fix-issues:42', new Date());
    assert.equal(claimed?.id, first.id);
    const again = request('fix-issues:42');
    assert.equal(enqueueRequest(dirs, again, 10).status, 'enqueued');
    // The claimed run and the new request are two files, not one.
    assert.equal(readLedgerEntry(dirs, first.id)?.state, 'claimed');
    assert.deepEqual(
      listQueue(dirs).map(r => r.id),
      [again.id]
    );
  }));

test('enqueue: a full queue rejects the new request and keeps every accepted one', () =>
  withDirs(dirs => {
    const a = request('t:1');
    const b = request('t:2');
    enqueueRequest(dirs, a, 2);
    enqueueRequest(dirs, b, 2);
    assert.deepEqual(enqueueRequest(dirs, request('t:3'), 2), {
      status: 'full',
    });
    assert.deepEqual(
      listQueue(dirs).map(r => r.id),
      [a.id, b.id]
    );
  }));

test('claim: the request moves into the ledger as claimed, payload inline; a second claim gets nothing', () =>
  withDirs(dirs => {
    const r = request('t:1', { payload: { issue: { number: 42 } } });
    enqueueRequest(dirs, r, 10);
    const now = new Date('2026-09-29T10:01:00.000Z');
    const entry = claimRequest(dirs, 't:1', now);
    assert.deepEqual(entry, {
      id: r.id,
      state: 'claimed',
      slot: true,
      agent: 'pi',
      run: null,
      request: r,
      claimedAt: now.toISOString(),
    });
    assert.deepEqual(readLedgerEntry(dirs, r.id), entry);
    assert.equal(claimRequest(dirs, 't:1', now), undefined);
    assert.deepEqual(listQueue(dirs), []);
  }));

test('claim: of eight processes racing for one request, exactly one wins, by rename', () =>
  withDirs(async dirs => {
    const r = request('race:1');
    enqueueRequest(dirs, r, 10);
    const module = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'runsSpool.js'
    );
    const script = `import { claimRequest } from ${JSON.stringify(module)};
      const dirs = JSON.parse(process.argv[1]);
      const won = claimRequest(dirs, 'race:1', new Date());
      process.stdout.write(won ? 'won' : 'lost');`;
    const outcomes = await Promise.all(
      Array.from(
        { length: 8 },
        () =>
          new Promise<string>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ['--input-type=module', '-e', script, JSON.stringify(dirs)],
              { stdio: ['ignore', 'pipe', 'inherit'] }
            );
            let out = '';
            child.stdout.on('data', chunk => (out += chunk));
            child.on('error', reject);
            child.on('exit', () => resolve(out));
          })
      )
    );
    assert.equal(outcomes.filter(o => o === 'won').length, 1, outcomes.join());
    assert.equal(outcomes.filter(o => o === 'lost').length, 7);
    assert.equal(listLedger(dirs).length, 1);
  }));

test('a half-written or corrupt record reads as absent, never throws', () =>
  withDirs(dirs => {
    fs.writeFileSync(path.join(dirs.queue, 'broken.json'), '{"id": "trg-');
    fs.writeFileSync(path.join(dirs.live, 'broken.json'), 'not json');
    fs.writeFileSync(path.join(dirs.live, 'wrong.json'), '{"id": 7}');
    // A temp file mid-write is never a record.
    fs.writeFileSync(path.join(dirs.live, 'x.json.123.tmp'), '{}');
    assert.deepEqual(listQueue(dirs), []);
    assert.deepEqual(listLedger(dirs), []);
    assert.equal(claimRequest(dirs, 'broken', new Date()), undefined);
  }));

test('a claim cut short between rename and rewrite reads as claimed', () =>
  withDirs(dirs => {
    const r = request('t:1');
    fs.writeFileSync(ledgerFile(dirs, r.id), JSON.stringify(r));
    assert.equal(readLedgerEntry(dirs, r.id)?.state, 'claimed');
    assert.equal(readLedgerEntry(dirs, r.id)?.request?.key, 't:1');
  }));

test('expireQueue: past the TTL from enqueuedAt a request is dropped unstarted; the ledger is never touched', () =>
  withDirs(dirs => {
    const old = request('t:old', { enqueuedAt: '2026-09-26T10:00:00.000Z' });
    const fresh = request('t:fresh', {
      enqueuedAt: '2026-09-29T09:00:00.000Z',
    });
    const running = request('t:run', {
      enqueuedAt: '2026-09-20T10:00:00.000Z',
    });
    enqueueRequest(dirs, old, 10);
    enqueueRequest(dirs, fresh, 10);
    enqueueRequest(dirs, running, 10);
    claimRequest(dirs, 't:run', new Date('2026-09-20T10:00:01.000Z'));

    const now = new Date('2026-09-29T10:00:00.000Z');
    const dropped = expireQueue(dirs, now, 24 * 60 * 60 * 1000);

    assert.deepEqual(
      dropped.map(r => r.key),
      ['t:old']
    );
    assert.deepEqual(
      listQueue(dirs).map(r => r.key),
      ['t:fresh']
    );
    assert.equal(readLedgerEntry(dirs, running.id)?.state, 'claimed');
  }));

test('sweepLedger: terminal entries go after the retention window, running ones never', () =>
  withDirs(dirs => {
    const base = { slot: false, agent: 'pi', run: null } as const;
    writeLedgerEntry(dirs, {
      ...base,
      id: newRequestId('man'),
      state: 'done',
      endedAt: '2026-09-29T08:00:00.000Z',
    });
    const recent = writeLedgerEntry(dirs, {
      ...base,
      id: newRequestId('man'),
      state: 'failed',
      endedAt: '2026-09-29T09:30:00.000Z',
    });
    const running = writeLedgerEntry(dirs, {
      ...base,
      id: newRequestId('man'),
      state: 'running',
      startedAt: '2026-09-28T00:00:00.000Z',
    });
    const swept = sweepLedger(
      dirs,
      new Date('2026-09-29T10:00:00.000Z'),
      60 * 60 * 1000
    );
    assert.equal(swept.length, 1);
    assert.deepEqual(
      listLedger(dirs)
        .map(e => ledgerFile(dirs, e.id))
        .sort(),
      [recent, running].sort()
    );
  }));

test('patchLedgerFile: merges into the entry; a missing entry stays missing', () =>
  withDirs(dirs => {
    const id = newRequestId('man');
    const file = writeLedgerEntry(dirs, {
      id,
      state: 'running',
      slot: false,
      agent: 'pi',
      run: null,
    });
    patchLedgerFile(file, { run: 'e/pi/x-1', container: 'e-pi-x-1' });
    assert.equal(readLedgerEntry(dirs, id)?.run, 'e/pi/x-1');
    assert.equal(readLedgerEntry(dirs, id)?.state, 'running');
    patchLedgerFile(ledgerFile(dirs, newRequestId('man')), { state: 'done' });
    assert.equal(listLedger(dirs).length, 1);
  }));
