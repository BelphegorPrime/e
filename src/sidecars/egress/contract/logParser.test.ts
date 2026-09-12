import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUERY_RE,
  parseDnsmasqLog,
  parseLogLine,
  toISO8601,
} from './logParser.js';

const NOW = new Date('2026-09-11T12:00:00Z');

test("QUERY_RE matches dnsmasq's --log-facility=<file> format (no syslog hostname field)", () => {
  const q = QUERY_RE.exec(
    'Sep  7 15:00:00 dnsmasq[1]: query[A] oidc.us-east-1.amazonaws.com from 127.0.0.1'
  );
  assert.ok(q);
  assert.equal(q[4], 'oidc.us-east-1.amazonaws.com');
});

test('toISO8601: uses the current year (dnsmasq logs none) and UTC', () => {
  assert.equal(
    toISO8601('Sep', '7', '15:00:00', NOW),
    '2026-09-07T15:00:00.000Z'
  );
  assert.equal(toISO8601('Xyz', '7', '15:00:00', NOW), null);
});

test('toISO8601: a December line read on New Year belongs to last year, not next December', () => {
  const newYear = new Date('2027-01-01T00:10:00Z');
  assert.equal(
    toISO8601('Dec', '31', '23:59:00', newYear),
    '2026-12-31T23:59:00.000Z'
  );
  // Within a day ahead is clock skew, not a year boundary.
  assert.equal(
    toISO8601('Jan', '1', '06:00:00', newYear),
    '2027-01-01T06:00:00.000Z'
  );
});

test('parseLogLine: query lines become entries; replies and anything else are null', () => {
  assert.equal(
    parseLogLine(
      'Sep 11 16:15:23 dnsmasq[1]: reply registry.npmjs.org is 104.16.7.34'
    ),
    null
  );
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
    'Sep  7 15:00:00 dnsmasq[1]: query[A] cdn.blocked.example from 127.0.0.1',
    ['blocked.example'],
    NOW
  );
  assert.equal(entry?.action, 'deny(sinkholed)');
});

test('parseDnsmasqLog: one entry per query, replies and noise skipped, order kept', () => {
  const raw = [
    'Sep  7 15:00:00 dnsmasq[1]: started, version 2.90',
    'Sep  7 15:00:01 dnsmasq[1]: query[A] a.example from 127.0.0.1',
    'Sep  7 15:00:01 dnsmasq[1]: query[AAAA] a.example from 127.0.0.1',
    'Sep  7 15:00:02 dnsmasq[1]: reply a.example is <CNAME>',
    'Sep  7 15:00:02 dnsmasq[1]: reply cdn.a.example is 1.2.3.4',
    '',
  ].join('\n');
  assert.deepEqual(
    parseDnsmasqLog(raw, [], NOW).map(e => [e.domain, e.timestamp]),
    [
      ['a.example', '2026-09-07T15:00:01.000Z'],
      ['a.example', '2026-09-07T15:00:01.000Z'],
    ]
  );
});
