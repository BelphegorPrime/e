import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Trigger } from './index.js';
import {
  CRON_DEFAULT_TZ,
  cronDue,
  cronExprError,
  cronFire,
  nextCronFire,
  tickStamp,
} from './cron.js';

/*
 * Cron (ADR-0016 section 8): croner is the next-run calculator only. What is
 * ours: 5 fields plus the `@`-aliases, UTC by default, the spring gap having
 * no matching instant, and the rule that a missed tick is discarded.
 */

const at = (iso: string): Date => new Date(iso);
const iso = (date: Date | undefined): string | undefined => date?.toISOString();

test('nextCronFire: tz defaults to UTC, never the host zone', () => {
  assert.equal(CRON_DEFAULT_TZ, 'UTC');
  assert.equal(
    iso(nextCronFire({ expr: '0 3 * * *' }, at('2026-01-01T05:00:00Z'))),
    '2026-01-02T03:00:00.000Z'
  );
  assert.equal(
    iso(nextCronFire({ expr: '@daily' }, at('2026-01-01T05:00:00Z'))),
    '2026-01-02T00:00:00.000Z'
  );
});

test('nextCronFire: strictly after `from`, so a fire never repeats its own instant', () => {
  assert.equal(
    iso(nextCronFire({ expr: '0 3 * * *' }, at('2026-01-01T03:00:00Z'))),
    '2026-01-02T03:00:00.000Z'
  );
});

test('nextCronFire: Europe/Berlin 03:00 is 02:00 UTC in winter and 01:00 UTC in summer', () => {
  const on = { expr: '0 3 * * *', tz: 'Europe/Berlin' };
  // Spring forward on 2026-03-29.
  assert.equal(
    iso(nextCronFire(on, at('2026-03-28T12:00:00Z'))),
    '2026-03-29T01:00:00.000Z'
  );
  assert.equal(
    iso(nextCronFire(on, at('2026-03-27T12:00:00Z'))),
    '2026-03-28T02:00:00.000Z'
  );
  // Fall back on 2026-10-25.
  assert.equal(
    iso(nextCronFire(on, at('2026-10-24T12:00:00Z'))),
    '2026-10-25T02:00:00.000Z'
  );
});

test('nextCronFire: the spring gap has no matching instant; 02:30 is skipped that day, not shifted', () => {
  const on = { expr: '30 2 * * *', tz: 'Europe/Berlin' };
  assert.equal(
    iso(nextCronFire(on, at('2026-03-28T12:00:00Z'))),
    '2026-03-30T00:30:00.000Z'
  );
});

test('nextCronFire: the autumn hour is not replayed; 02:30 fires once', () => {
  const on = { expr: '30 2 * * *', tz: 'Europe/Berlin' };
  const first = nextCronFire(on, at('2026-10-24T12:00:00Z'));
  assert.equal(iso(first), '2026-10-25T00:30:00.000Z');
  assert.equal(iso(nextCronFire(on, first!)), '2026-10-26T01:30:00.000Z');
});

test('nextCronFire: a schedule that never matches has no next fire', () => {
  assert.equal(
    nextCronFire({ expr: '0 0 30 2 *' }, at('2026-01-01T00:00:00Z')),
    undefined
  );
});

test('cronExprError: 5 fields and the @-aliases pass; seconds, @reboot, garbage and a bad zone do not', () => {
  for (const ok of [
    '0 3 * * *',
    '*/5 * * * 1-5',
    '@hourly',
    '@daily',
    '@weekly',
    '@monthly',
    '@yearly',
    '@annually',
    '@midnight',
  ]) {
    assert.equal(cronExprError(ok, undefined), undefined, ok);
  }
  assert.match(cronExprError('* * * * * *', undefined)!, /5/);
  assert.match(cronExprError('@reboot', undefined)!, /reboot/);
  assert.match(cronExprError('61 * * * *', undefined)!, /minute/);
  assert.match(cronExprError('nope', undefined)!, /./);
  assert.match(cronExprError('0 3 * * *', 'Mars/Olympus')!, /Mars\/Olympus/);
  assert.equal(cronExprError('0 3 * * *', 'Europe/Berlin'), undefined);
});

test('cronDue: waits before the scheduled time, fires within the grace, discards a tick missed past it', () => {
  const scheduled = at('2026-09-18T03:00:00Z');
  assert.equal(cronDue(scheduled, at('2026-09-18T02:59:59Z')), 'wait');
  assert.equal(cronDue(scheduled, scheduled), 'fire');
  // Noticed 20 s late, as a 30 s tick will: still this tick.
  assert.equal(cronDue(scheduled, at('2026-09-18T03:00:20Z')), 'fire');
  // A laptop that slept through it: discarded, never caught up.
  assert.equal(cronDue(scheduled, at('2026-09-18T03:05:00Z')), 'missed');
});

test('tickStamp: minute-granular, UTC, compact', () => {
  assert.equal(
    tickStamp(new Date('2026-09-18T03:00:42.123Z')),
    '20260918T0300Z'
  );
});

const nightly: Trigger = {
  name: 'nightly',
  enabled: true,
  agent: 'pi',
  prompt: 'Nightly sweep {{tick}} by {{trigger}}.',
  overlap: 'skip',
  on: { type: 'cron', expr: '0 3 * * *' },
};

test('cronFire: keyed by the scheduled time, not by when the tick noticed it', () => {
  const fire = cronFire(nightly, at('2026-09-18T03:00:00Z'), new Set());
  assert.deepEqual(fire, {
    trigger: 'nightly',
    request: {
      key: 'nightly:20260918T0300Z',
      trigger: 'nightly',
      agent: 'pi',
      prompt: 'Nightly sweep 20260918T0300Z by nightly.',
      event: { source: 'cron', event: 'tick', id: '20260918T0300Z' },
    },
  });
});

test('cronFire: overlap "skip" drops the tick while the trigger owns a live run; "allow" does not', () => {
  const live = new Set(['nightly']);
  const skipped = cronFire(nightly, at('2026-09-18T03:00:00Z'), live);
  assert.match((skipped as { dropped: string }).dropped, /overlap: skip/);
  const allowed = cronFire(
    { ...nightly, overlap: 'allow' },
    at('2026-09-18T03:00:00Z'),
    live
  );
  assert.ok('request' in allowed);
});

test('cronFire: a payload path in the prompt drops the tick, which has no payload', () => {
  const fire = cronFire(
    { ...nightly, prompt: 'Fix #{{issue.number}}' },
    at('2026-09-18T03:00:00Z'),
    new Set()
  );
  assert.match((fire as { dropped: string }).dropped, /needs an event payload/);
});
