import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { TriggerListItem } from '../../core/trigger/listing.js';
import { eBaseDir } from '../../core/store/paths.js';
import { deadListLines, fetchServeListing, triggerListLines } from './index.js';

/*
 * `e trigger list` (ADR-0016). A trigger that has never fired is invisible in
 * the run list - which is exactly the "why is my schedule not running?" case -
 * so this is where that question gets an answer, and where a load error is
 * shown. That makes the command the linter for trigger files.
 */

const nightly: TriggerListItem = {
  id: 'nightly',
  enabled: true,
  agent: 'claude-pr',
  type: 'cron',
  on: 'cron 0 3 * * * Europe/Berlin',
  nextFireAt: '2026-09-19T01:00:00.000Z',
  lastFiredAt: null,
  lastRequestId: null,
};

test('triggerListLines: an enabled trigger shows its source, its agent and its next fire at a glance', () => {
  const [line] = triggerListLines([nightly]);
  assert.match(line.text, /nightly/);
  assert.match(line.text, /claude-pr/);
  assert.match(line.text, /0 3 \* \* \*/);
  assert.match(line.text, /Europe\/Berlin/);
  assert.match(line.text, /next 2026-09-19T01:00:00\.000Z/);
});

test('triggerListLines: without a serve the last fire is unknown, not never', () => {
  const [line] = triggerListLines([nightly]);
  assert.match(line.text, /last fired unknown \(no serve answering/);
  const [since] = triggerListLines([nightly], {
    activitySince: '2026-09-18T00:00:00.000Z',
  });
  assert.match(
    since.text,
    /last fired unknown \(not since serve started 2026-09-18T00:00:00\.000Z\)/
  );
  const [fired] = triggerListLines([
    {
      ...nightly,
      lastFiredAt: '2026-09-18T01:00:05.000Z',
      lastRequestId: 'trg-1',
    },
  ]);
  assert.match(fired.text, /last fired 2026-09-18T01:00:05\.000Z \(trg-1\)/);
});

test('triggerListLines: a webhook trigger has no next fire to show', () => {
  const [line] = triggerListLines([
    { ...nightly, type: 'webhook', on: 'github issues', nextFireAt: null },
  ]);
  assert.doesNotMatch(line.text, /next/);
});

test('triggerListLines: disabled and failed-to-load are different diagnoses', () => {
  const lines = triggerListLines([
    { ...nightly, id: 'off', enabled: false, nextFireAt: null },
    {
      id: 'broken',
      enabled: false,
      nextFireAt: null,
      lastFiredAt: null,
      lastRequestId: null,
      error: 'no trigger.json in broken/',
    },
  ]);
  assert.match(lines[0].text, /disabled/i);
  assert.doesNotMatch(lines[0].text, /next/);
  assert.equal(lines[0].level, 'info');
  assert.match(lines[1].text, /no trigger\.json/);
  assert.equal(lines[1].level, 'warn', 'a broken trigger is not merely off');
});

test('triggerListLines: an empty store says so rather than printing nothing', () => {
  const [line] = triggerListLines([]);
  assert.match(line.text, /no triggers/i);
});

/** A stand-in `serve` answering `/api/triggers` with `body`. */
async function withServe(
  body: unknown,
  fn: (port: number) => Promise<void>
): Promise<void> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('fetchServeListing: asks the detached serve, and only trusts it for this very store', async () => {
  const root = '/tmp/some-repo';
  const listing = {
    store: path.resolve(eBaseDir(root)),
    activitySince: '2026-09-18T00:00:00.000Z',
    triggers: [nightly],
  };
  await withServe(listing, async port => {
    const state = { pid: 1, host: '0.0.0.0', port };
    assert.deepEqual(await fetchServeListing(root, state), listing);
    // Another Store's serve names other triggers.
    assert.equal(await fetchServeListing('/tmp/other-repo', state), undefined);
  });
  assert.equal(await fetchServeListing(root, undefined), undefined);
  // Nobody listening: unknown, quickly.
  assert.equal(
    await fetchServeListing(root, { pid: 1, host: '127.0.0.1', port: 1 }),
    undefined
  );
});

test('deadListLines: one line per dead request, metadata only, never the payload', () => {
  const lines = deadListLines([
    {
      request: {
        id: 'trg-01K00000000000000000000001',
        key: 'fix:d-1',
        trigger: 'fix',
        agent: 'pi',
        prompt: 'p',
        payload: { secret: 'do-not-print' },
        enqueuedAt: '2026-09-27T08:00:00.000Z',
      },
      stage: 'base',
      reason: 'Base error: nope',
      diedAt: '2026-09-28T08:00:00.000Z',
    },
  ]);
  assert.equal(
    lines[0].text,
    'trg-01K00000000000000000000001 fix:d-1 (base, 2026-09-28T08:00:00.000Z): Base error: nope'
  );
  assert.doesNotMatch(lines[0].text, /do-not-print/);
  assert.match(deadListLines([])[0].text, /No dead requests/);
});
