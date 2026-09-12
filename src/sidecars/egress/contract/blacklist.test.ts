import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendBlacklistDomain,
  blacklistLineDomain,
  isSinkholed,
  parseBlacklistDomains,
  removeBlacklistDomain,
} from './blacklist.js';

test('parseBlacklistDomains: extracts domains from dnsmasq address= directives (the format --conf-dir requires)', () => {
  assert.deepEqual(parseBlacklistDomains('address=/example.com/0.0.0.0\n'), [
    'example.com',
  ]);
  assert.deepEqual(
    parseBlacklistDomains(
      '# comment\n; note\n\naddress=/foo.com/0.0.0.0\naddress=/bar.com/0.0.0.0\n'
    ),
    ['foo.com', 'bar.com']
  );
});

test('parseBlacklistDomains: one domain yields an A and an AAAA line; it lists once', () => {
  assert.deepEqual(
    parseBlacklistDomains('address=/foo.com/0.0.0.0\naddress=/foo.com/::\n'),
    ['foo.com']
  );
});

test('parseBlacklistDomains: tolerates a hand-written bare domain and skips ip:port lines', () => {
  assert.deepEqual(parseBlacklistDomains('Plain-Domain.Example.\n'), [
    'plain-domain.example',
  ]);
  assert.deepEqual(parseBlacklistDomains('203.0.113.7:8443\n'), []);
  // Out-of-range port or non-IPv4 host: not an ip:port, so it falls through to a domain.
  assert.deepEqual(parseBlacklistDomains('1.2.3.4:0\nhost:8080\n'), [
    '1.2.3.4:0',
    'host:8080',
  ]);
});

test('blacklistLineDomain: comments and blanks are null', () => {
  assert.equal(blacklistLineDomain('# x'), null);
  assert.equal(blacklistLineDomain('   '), null);
  assert.equal(blacklistLineDomain('address=/A.Example./::'), 'a.example');
});

test('isSinkholed: matches the domain itself and every subdomain, never a suffix lookalike', () => {
  const bl = ['example.com'];
  assert.equal(isSinkholed('example.com', bl), true);
  assert.equal(isSinkholed('API.Example.com.', bl), true);
  assert.equal(isSinkholed('a.b.example.com', bl), true);
  assert.equal(isSinkholed('notexample.com', bl), false);
  assert.equal(isSinkholed('example.org', bl), false);
});

test('appendBlacklistDomain: writes address= directives for both address families (IPv4-only leaves AAAA reachable)', () => {
  assert.equal(
    appendBlacklistDomain('', 'Example.COM.'),
    'address=/example.com/0.0.0.0\naddress=/example.com/::\n'
  );
  assert.equal(
    appendBlacklistDomain('# header\naddress=/a.com/0.0.0.0\n\n', 'b.com'),
    '# header\naddress=/a.com/0.0.0.0\naddress=/b.com/0.0.0.0\naddress=/b.com/::\n'
  );
});

test('appendBlacklistDomain: is idempotent for an already listed domain', () => {
  const content = 'address=/a.com/0.0.0.0\naddress=/a.com/::\n';
  assert.equal(appendBlacklistDomain(content, 'A.com'), content);
});

test('removeBlacklistDomain: drops every address family line of the domain and keeps the rest', () => {
  const content =
    '# keep\naddress=/a.com/0.0.0.0\naddress=/a.com/::\naddress=/b.com/0.0.0.0\n';
  assert.equal(
    removeBlacklistDomain(content, 'a.com'),
    '# keep\naddress=/b.com/0.0.0.0\n'
  );
  assert.equal(removeBlacklistDomain('', 'a.com'), '');
  assert.equal(removeBlacklistDomain('a.com\n', 'A.COM.'), '');
});
