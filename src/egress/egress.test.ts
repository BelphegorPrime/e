import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBlacklist,
  renderDnsmasqConf,
  renderIptablesRules,
} from './index.js';

test('parseBlacklist: empty content yields nothing', () => {
  assert.deepEqual(parseBlacklist(''), { domains: [], ipPorts: [] });
});

test('parseBlacklist: ignores blank lines and comment markers', () => {
  const out = parseBlacklist('# heading\n\n; note\n    \nblocked.example\n');
  assert.deepEqual(out, { domains: ['blocked.example'], ipPorts: [] });
});

test('parseBlacklist: an ip:port line is a blacklisted IP, not a domain', () => {
  const out = parseBlacklist('example.com\n203.0.113.7:8443\n');
  assert.deepEqual(out, {
    domains: ['example.com'],
    ipPorts: ['203.0.113.7:8443'],
  });
});

test('parseBlacklist: treats a colon-with-numeric-port as ip:port; a colon elsewhere as a domain', () => {
  assert.deepEqual(parseBlacklist('1.2.3.4:9999\n').ipPorts, ['1.2.3.4:9999']);
  // A hostname (no numeric port) stays a domain even though it has a colon.
  assert.deepEqual(parseBlacklist('v6:[::1]\n').domains, ['v6:[::1]']);
});

test('parseBlacklist: normalizes domains to lowercase and trims dots + whitespace', () => {
  const out = parseBlacklist('  Blocked.Example.  \n.example.com\n');
  assert.deepEqual(out.domains, ['blocked.example', 'example.com']);
});

test('parseBlacklist: drops a structurally invalid ip:port (bad port range / bad ip)', () => {
  // 1.2.3.4:0 (port zero) and 99999 (out of range) are not valid ip:port; the
  // former falls through to the domain half, the latter is a domain too.
  const out = parseBlacklist('1.2.3.4:0\n1.2.3.4:99999\n');
  assert.deepEqual(out, {
    domains: ['1.2.3.4:0', '1.2.3.4:99999'],
    ipPorts: [],
  });
});

test('renderDnsmasqConf: one address=/domain/sinkhole line per domain', () => {
  assert.equal(
    renderDnsmasqConf(['example.com', 'evil.other']),
    'address=/example.com/0.0.0.0\naddress=/evil.other/0.0.0.0'
  );
});

test('renderDnsmasqConf: empty domains renders nothing, custom sinkhole honored', () => {
  assert.equal(renderDnsmasqConf([]), '');
  assert.equal(
    renderDnsmasqConf(['x.example'], '127.0.0.1'),
    'address=/x.example/127.0.0.1'
  );
});

test('renderIptablesRules: one REJECT per ip:port on the EGRESS chain', () => {
  const out = renderIptablesRules(['203.0.113.7:8443', '203.0.113.8:25']);
  assert.match(
    out,
    /iptables -A EGRESS -d 203\.0\.113\.7 -p tcp --dport 8443 -j REJECT/
  );
  assert.match(
    out,
    /iptables -A EGRESS -d 203\.0\.113\.8 -p tcp --dport 25 -j REJECT/
  );
});

test('renderIptablesRules: empty ip:port list renders nothing', () => {
  assert.equal(renderIptablesRules([]), '');
});
