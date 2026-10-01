import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileHostSlots, hostSlotsDir } from './hostSlots.js';

/*
 * The host-wide candidate bound (ADR-0019 section 9): numbered lease files in
 * a directory every coordinator on the host reads, so concurrent `e fuse`
 * invocations share one count instead of each keeping its own in memory.
 */

function withDir(fn: (dir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-host-slots-'));
  try {
    fn(path.join(root, 'slots'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const owner = (candidate: string) => ({ fusion: 'fusion-a', candidate });

test('hostSlotsDir: beside the fusion spools under the worktrees dir', () => {
  assert.equal(
    hostSlotsDir('/tmp/e-worktrees'),
    path.join('/tmp/e-worktrees', '.fusion', '.slots')
  );
});

test('fileHostSlots: at most `limit` leases at once; a release frees one', () => {
  withDir(dir => {
    const slots = fileHostSlots(dir, 2);
    const a = slots.tryAcquire(owner('cand-001'));
    const b = slots.tryAcquire(owner('cand-002'));
    assert.ok(a && b);
    assert.equal(slots.tryAcquire(owner('cand-003')), undefined, 'full');
    a.release();
    const c = slots.tryAcquire(owner('cand-003'));
    assert.ok(c, 'the freed slot is taken');
    assert.equal(fs.readdirSync(dir).length, 2, 'no temp file left behind');
  });
});

test('fileHostSlots: two coordinators share one count', () => {
  withDir(dir => {
    // Another `e fuse` on this host: a different pid, both alive.
    const mine = fileHostSlots(dir, 2, { pid: 100, isAlive: () => true });
    const theirs = fileHostSlots(dir, 2, { pid: 200, isAlive: () => true });
    assert.ok(theirs.tryAcquire({ fusion: 'fusion-b', candidate: 'cand-001' }));
    assert.ok(mine.tryAcquire(owner('cand-001')));
    assert.equal(mine.tryAcquire(owner('cand-002')), undefined);
    assert.equal(
      theirs.tryAcquire({ fusion: 'fusion-b', candidate: 'cand-002' }),
      undefined
    );
  });
});

test('fileHostSlots: each coordinator stops at its own limit; a smaller one never takes a slot past it', () => {
  withDir(dir => {
    const wide = fileHostSlots(dir, 3, { pid: 100, isAlive: () => true });
    const narrow = fileHostSlots(dir, 1, { pid: 200, isAlive: () => true });
    assert.ok(wide.tryAcquire(owner('cand-001')));
    assert.equal(
      narrow.tryAcquire({ fusion: 'fusion-b', candidate: 'cand-001' }),
      undefined,
      'slot 0 is taken and slot 1 is past its limit'
    );
    assert.ok(wide.tryAcquire(owner('cand-002')));
  });
});

test("fileHostSlots: a dead coordinator's lease is reclaimed", () => {
  withDir(dir => {
    const dead = fileHostSlots(dir, 1, { pid: 100, isAlive: () => true });
    assert.ok(dead.tryAcquire(owner('cand-001')));
    // That coordinator was killed outright: its lease file stays behind.
    const next = fileHostSlots(dir, 1, {
      pid: 200,
      isAlive: pid => pid !== 100,
    });
    const lease = next.tryAcquire({
      fusion: 'fusion-b',
      candidate: 'cand-001',
    });
    assert.ok(lease, 'the stale lease does not hold the slot');
    assert.equal(fs.readdirSync(dir).length, 1, 'the stale file is gone');
    const held = JSON.parse(
      fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8')
    );
    assert.equal(held.pid, 200);
    assert.equal(held.fusion, 'fusion-b');
  });
});

test('fileHostSlots: a lease whose coordinator died but whose candidate still runs holds its slot', () => {
  withDir(dir => {
    const first = fileHostSlots(dir, 1, { pid: 100, isAlive: () => true });
    // The candidate's `e spawn` runs in a process group of its own, so it
    // outlives a coordinator killed outright.
    first.tryAcquire(owner('cand-001'))!.attach(300);
    const alive = new Set([300]);
    const next = fileHostSlots(dir, 1, {
      pid: 200,
      isAlive: pid => alive.has(pid),
    });
    assert.equal(
      next.tryAcquire({ fusion: 'fusion-b', candidate: 'cand-001' }),
      undefined,
      'still in use'
    );
    alive.delete(300);
    assert.ok(next.tryAcquire({ fusion: 'fusion-b', candidate: 'cand-001' }));
  });
});

test('fileHostSlots: an unreadable lease file is reclaimed', () => {
  withDir(dir => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'slot-0.json'), '{not json');
    const slots = fileHostSlots(dir, 1, { isAlive: () => true });
    assert.ok(slots.tryAcquire(owner('cand-001')));
  });
});

test('fileHostSlots: a release only removes its own lease', () => {
  withDir(dir => {
    const first = fileHostSlots(dir, 1, { pid: 100, isAlive: () => true });
    const lease = first.tryAcquire(owner('cand-001'))!;
    // Reclaimed as stale by another coordinator while this one still ran.
    const second = fileHostSlots(dir, 1, {
      pid: 200,
      isAlive: pid => pid !== 100,
    });
    assert.ok(second.tryAcquire({ fusion: 'fusion-b', candidate: 'cand-001' }));
    lease.release();
    lease.release();
    assert.equal(fs.readdirSync(dir).length, 1, "the other's lease stays");
    assert.equal(
      second.tryAcquire({ fusion: 'fusion-b', candidate: 'cand-002' }),
      undefined,
      'and still holds the slot'
    );
  });
});

test('fileHostSlots: the directory and its leases are private', () => {
  if (process.platform === 'win32') return;
  withDir(dir => {
    fileHostSlots(dir, 1).tryAcquire(owner('cand-001'));
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    const file = path.join(dir, fs.readdirSync(dir)[0]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});
