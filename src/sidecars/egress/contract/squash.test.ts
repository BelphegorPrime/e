import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLogQuery, squashEntries } from './squash.js';
import type { EgressLogEntry } from './types.js';

const at = (
  domain: string,
  second: string,
  action: EgressLogEntry['action'] = 'allow'
): EgressLogEntry => ({
  timestamp: `2026-09-07T15:00:${second}.000Z`,
  runID: '',
  domain,
  protocol: 'DNS',
  action,
});

test('squashEntries: one record per domain over the whole log, not per consecutive run', () => {
  // Interleaved traffic: a run-length squash would emit five records here.
  const out = squashEntries([
    at('a.example', '01'),
    at('b.example', '02'),
    at('a.example', '03'),
    at('b.example', '04'),
    at('a.example', '05'),
  ]);
  assert.deepEqual(out, [
    {
      domain: 'a.example',
      count: 3,
      firstSeen: '2026-09-07T15:00:01.000Z',
      lastSeen: '2026-09-07T15:00:05.000Z',
    },
    {
      domain: 'b.example',
      count: 2,
      firstSeen: '2026-09-07T15:00:02.000Z',
      lastSeen: '2026-09-07T15:00:04.000Z',
    },
  ]);
});

test('squashEntries: case and trailing-dot spellings are the same name to dnsmasq', () => {
  assert.deepEqual(
    squashEntries([
      at('A.Example.', '01'),
      at('a.example', '02'),
      at('a.example.', '03'),
    ]),
    [
      {
        domain: 'a.example',
        count: 3,
        firstSeen: '2026-09-07T15:00:01.000Z',
        lastSeen: '2026-09-07T15:00:03.000Z',
      },
    ]
  );
});

test('squashEntries: localhost resolves inside the stack and is dropped as noise', () => {
  assert.deepEqual(
    squashEntries([
      at('localhost', '01'),
      at('db.localhost.', '02'),
      at('a.example', '03'),
    ]).map(r => r.domain),
    ['a.example']
  );
});

test('applyLogQuery: since / domain / action / limit', () => {
  const entries = [
    at('a.example', '01'),
    at('b.example', '02', 'deny(sinkholed)'),
    at('a.example', '03'),
  ];
  assert.equal(applyLogQuery(entries, {}).length, 3);
  assert.deepEqual(
    applyLogQuery(entries, { since: '2026-09-07T15:00:02Z' }).map(
      e => e.timestamp
    ),
    ['2026-09-07T15:00:02.000Z', '2026-09-07T15:00:03.000Z']
  );
  assert.equal(applyLogQuery(entries, { domain: 'a.example' }).length, 2);
  assert.equal(applyLogQuery(entries, { action: 'deny(sinkholed)' }).length, 1);
  // limit keeps the newest entries (tail of the log).
  assert.deepEqual(
    applyLogQuery(entries, { limit: '1' }).map(e => e.timestamp),
    ['2026-09-07T15:00:03.000Z']
  );
});

test('applyLogQuery: garbage limits mean no limit; domain matching ignores case and a trailing dot; bad since is ignored', () => {
  const entries = [at('A.Example.', '01'), at('b.example', '02')];
  assert.equal(applyLogQuery(entries, { limit: '0' }).length, 2);
  assert.equal(applyLogQuery(entries, { limit: 'abc' }).length, 2);
  assert.equal(applyLogQuery(entries, { limit: '-1' }).length, 2);
  assert.equal(applyLogQuery(entries, { domain: 'a.example' }).length, 1);
  assert.equal(applyLogQuery(entries, { since: 'not a date' }).length, 2);
});
