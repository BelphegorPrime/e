import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUERY_RE,
  REPLY_RE,
  parseDnsmasqLog,
  parseLogLine,
  toISO8601,
} from './logParser.js';

const NOW = new Date('2026-09-11T12:00:00Z');

test("QUERY_RE/REPLY_RE match dnsmasq's --log-facility=<file> format (no syslog hostname field)", () => {
  const q = QUERY_RE.exec(
    'Sep  7 15:00:00 dnsmasq[1]: query[A] oidc.us-east-1.amazonaws.com from 127.0.0.1'
  );
  assert.ok(q);
  assert.equal(q[4], 'oidc.us-east-1.amazonaws.com');
  const r = REPLY_RE.exec(
    'Sep 11 16:15:23 dnsmasq[1]: reply registry.npmjs.org is 104.16.7.34'
  );
  assert.ok(r);
  assert.equal(r[4], 'registry.npmjs.org');
});

test('toISO8601: uses the current year (dnsmasq logs none) and UTC', () => {
  assert.equal(
    toISO8601('Sep', '7', '15:00:00', NOW),
    '2026-09-07T15:00:00.000Z'
  );
  assert.equal(toISO8601('Xyz', '7', '15:00:00', NOW), null);
});

test('parseLogLine: query and reply lines become entries; anything else is null', () => {
  assert.deepEqual(
    parseLogLine(
      'Sep  7 15:00:00 dnsmasq[1]: query[A] a.example from 127.0.0.1',
      [],
      NOW
    ),
    {
      timestamp: '2026-09-07T15:00:00.000Z',
      runID: '',
      domain: 'a.example',
      protocol: 'DNS',
      action: 'allow',
    }
  );
  assert.equal(
    parseLogLine('Sep  7 15:00:00 dnsmasq[1]: using nameserver 1.1.1.1#53'),
    null
  );
  assert.equal(parseLogLine(''), null);
});

test('parseLogLine: classifies blacklisted names (and their subdomains) as deny(sinkholed)', () => {
  const entry = parseLogLine(
    'Sep  7 15:00:00 dnsmasq[1]: reply cdn.blocked.example is 0.0.0.0',
    ['blocked.example'],
    NOW
  );
  assert.equal(entry?.action, 'deny(sinkholed)');
});

test('parseDnsmasqLog: skips non-matching lines and keeps order', () => {
  const raw = [
    'Sep  7 15:00:00 dnsmasq[1]: started, version 2.90',
    'Sep  7 15:00:01 dnsmasq[1]: query[A] a.example from 127.0.0.1',
    'Sep  7 15:00:02 dnsmasq[1]: reply a.example is 1.2.3.4',
    '',
  ].join('\n');
  assert.deepEqual(
    parseDnsmasqLog(raw, [], NOW).map(e => [e.domain, e.timestamp]),
    [
      ['a.example', '2026-09-07T15:00:01.000Z'],
      ['a.example', '2026-09-07T15:00:02.000Z'],
    ]
  );
});
