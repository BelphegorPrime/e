import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Trigger } from './index.js';
import { listingActivity, triggerListing } from './listing.js';

/*
 * The listing (ADR-0016 section 8): `nextFireAt` from `now`, needing no
 * `serve`; the last fire from `serve`'s memory, unknown without it.
 */

const now = new Date('2026-09-18T01:00:00Z');

const cron: Trigger = {
  name: 'nightly',
  enabled: true,
  agent: 'pi',
  prompt: 'p',
  overlap: 'skip',
  on: { type: 'cron', expr: '0 3 * * *', tz: 'Europe/Berlin' },
};

const hook: Trigger = {
  ...cron,
  name: 'labels',
  on: { type: 'webhook', source: 'github', event: 'issues', action: 'labeled' },
};

test('triggerListing: nextFireAt for an enabled cron trigger, null for a webhook, a disabled or a broken one', () => {
  const items = triggerListing(
    [
      { name: 'nightly', trigger: cron },
      { name: 'labels', trigger: hook },
      { name: 'off', trigger: { ...cron, name: 'off', enabled: false } },
      { name: 'broken', error: 'no trigger.json in broken/' },
    ],
    now
  );
  assert.deepEqual(items, [
    {
      id: 'nightly',
      enabled: true,
      agent: 'pi',
      type: 'cron',
      on: 'cron 0 3 * * * Europe/Berlin',
      nextFireAt: '2026-09-19T01:00:00.000Z',
      lastFiredAt: null,
      lastRequestId: null,
    },
    {
      id: 'labels',
      enabled: true,
      agent: 'pi',
      type: 'webhook',
      on: 'github issues.labeled',
      nextFireAt: null,
      lastFiredAt: null,
      lastRequestId: null,
    },
    {
      id: 'off',
      enabled: false,
      agent: 'pi',
      type: 'cron',
      on: 'cron 0 3 * * * Europe/Berlin',
      nextFireAt: null,
      lastFiredAt: null,
      lastRequestId: null,
    },
    {
      id: 'broken',
      enabled: false,
      nextFireAt: null,
      lastFiredAt: null,
      lastRequestId: null,
      error: 'no trigger.json in broken/',
    },
  ]);
});

test('triggerListing: the last fire comes from the activity handed in, for any trigger type', () => {
  const [item] = triggerListing([{ name: 'labels', trigger: hook }], now, {
    activity: id =>
      id === 'labels'
        ? { lastFiredAt: '2026-09-18T00:59:00.000Z', lastRequestId: 'trg-1' }
        : undefined,
  });
  assert.equal(item.lastFiredAt, '2026-09-18T00:59:00.000Z');
  assert.equal(item.lastRequestId, 'trg-1');
});

test('listingActivity: reads a serve listing back into activity, skipping what it does not know', () => {
  const activity = listingActivity({
    store: '/s/.e',
    activitySince: '2026-09-18T00:00:00.000Z',
    triggers: [
      {
        id: 'a',
        enabled: true,
        nextFireAt: null,
        lastFiredAt: '2026-09-18T00:01:00.000Z',
        lastRequestId: 'trg-a',
      },
      {
        id: 'b',
        enabled: true,
        nextFireAt: null,
        lastFiredAt: null,
        lastRequestId: null,
      },
    ],
  });
  assert.deepEqual(activity('a'), {
    lastFiredAt: '2026-09-18T00:01:00.000Z',
    lastRequestId: 'trg-a',
  });
  assert.equal(activity('b'), undefined);
  assert.equal(listingActivity(undefined)('a'), undefined);
});
