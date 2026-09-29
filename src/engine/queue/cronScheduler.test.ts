import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CronScheduler, type SchedulerQueue } from './cronScheduler.js';
import type { NewRunRequest } from './runQueue.js';
import type { EnqueueResult } from './runsSpool.js';

/*
 * The cron step of the `serve` tick (ADR-0016 section 8): stateless across
 * restarts, keyed by the scheduled time, reloading edited triggers per tick,
 * and one bad expression disabling one trigger.
 */

class FakeQueue implements SchedulerQueue {
  readonly requests: NewRunRequest[] = [];
  readonly live = new Set<string>();
  enqueue(request: NewRunRequest): EnqueueResult {
    this.requests.push(request);
    return {
      status: 'enqueued',
      request: { ...request, id: 'trg-x', enqueuedAt: '' },
    };
  }
  liveTriggers(): Set<string> {
    return new Set(this.live);
  }
}

function withStore(
  fn: (ctx: {
    root: string;
    write: (name: string, body: object) => void;
    queue: FakeQueue;
    scheduler: CronScheduler;
  }) => void
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-cron-'));
  let bump = 0;
  const write = (name: string, body: object): void => {
    const dir = path.join(root, '.e', 'triggers', name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'trigger.json');
    fs.writeFileSync(file, JSON.stringify(body));
    // Distinct mtimes even within one millisecond of test time.
    const stamp = new Date(Date.now() + ++bump * 1000);
    fs.utimesSync(file, stamp, stamp);
  };
  const queue = new FakeQueue();
  try {
    fn({
      root,
      write,
      queue,
      scheduler: new CronScheduler({
        store: { root, context: () => ({}) },
        queue,
      }),
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const nightly = (expr = '0 3 * * *', extra: object = {}): object => ({
  agent: 'pi',
  prompt: 'Sweep {{tick}}',
  on: { type: 'cron', expr },
  ...extra,
});

const at = (iso: string): Date => new Date(iso);

test('a due trigger fires on the tick with the scheduled-time key; noticing it 20 s late does not move it', () =>
  withStore(({ write, queue, scheduler }) => {
    write('nightly', nightly());
    scheduler.tick(at('2026-09-18T02:59:40Z'));
    assert.equal(queue.requests.length, 0);
    scheduler.tick(at('2026-09-18T03:00:20Z'));
    assert.equal(queue.requests.length, 1);
    assert.equal(queue.requests[0].key, 'nightly:20260918T0300Z');
    assert.equal(queue.requests[0].prompt, 'Sweep 20260918T0300Z');
    assert.deepEqual(queue.requests[0].event, {
      source: 'cron',
      event: 'tick',
      id: '20260918T0300Z',
    });
    // The next tick does not fire it again.
    scheduler.tick(at('2026-09-18T03:00:50Z'));
    assert.equal(queue.requests.length, 1);
  }));

test('a restart over a scheduled time fires nothing: nextRun is computed from now', () =>
  withStore(({ root, write, queue }) => {
    write('nightly', nightly());
    // A fresh scheduler is a restarted serve: 03:00 has just passed.
    const restarted = new CronScheduler({
      store: { root, context: () => ({}) },
      queue,
    });
    restarted.tick(at('2026-09-18T03:00:10Z'));
    assert.deepEqual(queue.requests, []);
    assert.equal(
      restarted.nextFireAt('nightly')?.toISOString(),
      '2026-09-19T03:00:00.000Z'
    );
  }));

test('a fire missed past the grace (a suspend) is discarded, never caught up', () =>
  withStore(({ write, queue, scheduler }) => {
    write('nightly', nightly());
    scheduler.tick(at('2026-09-18T02:59:40Z'));
    // Asleep until the afternoon.
    scheduler.tick(at('2026-09-18T15:00:00Z'));
    assert.deepEqual(queue.requests, []);
    assert.equal(
      scheduler.nextFireAt('nightly')?.toISOString(),
      '2026-09-19T03:00:00.000Z'
    );
  }));

test('overlap "skip" drops a tick while the trigger owns a live run; "allow" does not', () =>
  withStore(({ write, queue, scheduler }) => {
    write('skip', nightly());
    write('allow', nightly('0 3 * * *', { overlap: 'allow' }));
    queue.live.add('skip').add('allow');
    scheduler.tick(at('2026-09-18T02:59:40Z'));
    scheduler.tick(at('2026-09-18T03:00:10Z'));
    assert.deepEqual(
      queue.requests.map(r => r.trigger),
      ['allow']
    );
  }));

test('an invalid expression disables that one trigger; the others keep firing', () =>
  withStore(({ write, queue, scheduler }) => {
    write('broken', nightly('61 3 * * *'));
    write('nightly', nightly());
    scheduler.tick(at('2026-09-18T02:59:40Z'));
    scheduler.tick(at('2026-09-18T03:00:10Z'));
    assert.deepEqual(
      queue.requests.map(r => r.trigger),
      ['nightly']
    );
    assert.equal(scheduler.nextFireAt('broken'), undefined);
  }));

test('an edited trigger takes effect within one tick, its nextRun from now and never retroactive', () =>
  withStore(({ write, queue, scheduler }) => {
    write('nightly', nightly('0 3 * * *'));
    scheduler.tick(at('2026-09-18T01:00:00Z'));
    assert.equal(
      scheduler.nextFireAt('nightly')?.toISOString(),
      '2026-09-18T03:00:00.000Z'
    );
    // Moved to 01:00, which has already passed today: tomorrow, not now.
    write('nightly', nightly('0 1 * * *'));
    scheduler.tick(at('2026-09-18T01:00:30Z'));
    assert.deepEqual(queue.requests, []);
    assert.equal(
      scheduler.nextFireAt('nightly')?.toISOString(),
      '2026-09-19T01:00:00.000Z'
    );
    // A new trigger is picked up the same way.
    write('hourly', nightly('@hourly'));
    scheduler.tick(at('2026-09-18T01:10:00Z'));
    assert.equal(
      scheduler.nextFireAt('hourly')?.toISOString(),
      '2026-09-18T02:00:00.000Z'
    );
  }));

test('a disabled or webhook trigger has no next fire', () =>
  withStore(({ write, scheduler }) => {
    write('off', nightly('0 3 * * *', { enabled: false }));
    write('hook', {
      agent: 'pi',
      prompt: 'p',
      on: { type: 'webhook', source: 'github', event: 'issues' },
    });
    scheduler.tick(at('2026-09-18T01:00:00Z'));
    assert.equal(scheduler.nextFireAt('off'), undefined);
    assert.equal(scheduler.nextFireAt('hook'), undefined);
  }));

test('a removed trigger is forgotten', () =>
  withStore(({ root, write, scheduler }) => {
    write('nightly', nightly());
    scheduler.tick(at('2026-09-18T01:00:00Z'));
    fs.rmSync(path.join(root, '.e', 'triggers', 'nightly'), {
      recursive: true,
    });
    scheduler.tick(at('2026-09-18T01:00:30Z'));
    assert.equal(scheduler.nextFireAt('nightly'), undefined);
  }));

test('a schedule with no next fire fires nothing, and is asked again each tick rather than dropped', () =>
  withStore(({ write, queue, scheduler }) => {
    write('never', nightly('0 0 30 2 *'));
    scheduler.tick(at('2026-09-18T01:00:00Z'));
    scheduler.tick(at('2026-09-18T01:00:30Z'));
    assert.equal(scheduler.nextFireAt('never'), undefined);
    assert.equal(queue.requests.length, 0);
  }));
