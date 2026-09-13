import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDomainOrSubdomain,
  isLocalhost,
  isValidDomain,
  normalizeDomain,
} from './domain.js';
import { appendBlacklistDomain } from './blacklist.js';

/**
 * `isValidDomain` is the only thing standing between a user-supplied string and
 * an `address=/<domain>/0.0.0.0` line in the dnsmasq config the shared resolver
 * reads through `--conf-dir` (see `render.ts`). Every rejection below is
 * therefore tied to what the accepted string would do to that file.
 */

test('isValidDomain: accepts the DNS names a sinkhole directive is written for', () => {
  assert.equal(isValidDomain('example.com'), true);
  assert.equal(isValidDomain('a.b.c.example.com'), true);
  assert.equal(isValidDomain('localhost'), true);
  // Digits everywhere, including a numeric TLD and a bare IPv4 literal: LDH
  // allows them and dnsmasq takes them as plain names.
  assert.equal(isValidDomain('example.123'), true);
  assert.equal(isValidDomain('1.2.3.4'), true);
  assert.equal(isValidDomain('3com.example'), true);
  // Hyphens inside a label, including the doubled one punycode uses.
  assert.equal(isValidDomain('ex--ample.example'), true);
});

test('isValidDomain: validates the normalized form, so case and the root dot pass', () => {
  assert.equal(isValidDomain('EXAMPLE.COM'), true);
  assert.equal(isValidDomain('Example.COM.'), true);
  // Only one trailing dot is stripped; a second leaves an empty last label.
  assert.equal(isValidDomain('example.com..'), false);
});

test('isValidDomain: rejects everything that would inject or corrupt a dnsmasq directive', () => {
  const injections = [
    // Closes the address= directive and opens a second one.
    'example.com/0.0.0.0\naddress=/evil.example',
    // Keeps one line but redirects the name at an attacker address instead of
    // sinkholing it: `address=/example.com/6.6.6.6/0.0.0.0`.
    'example.com/6.6.6.6',
    'evil.example/0.0.0.0\naddress=/#/',
    // A bare `/` alone already breaks the /domain/ field.
    'slash/inside.example',
    // dnsmasq comment characters would silently disable the rest of the line.
    '#example.com',
    ';example.com',
    'example.com#comment',
    'example.com;comment',
    // A second directive smuggled in behind a newline or carriage return.
    'example.com\naddress=/evil.example/0.0.0.0',
    'example.com\rserver=/evil.example/6.6.6.6',
    'example.com\r\nlog-queries',
    // dnsmasq splits directives on whitespace and `=`.
    'example.com example.org',
    'example.com\texample.org',
    'server=/example.com/6.6.6.6',
    // Quotes and a NUL would land inside the config file verbatim.
    '"example.com"',
    "'example.com'",
    'example.com\0',
    // Percent-escapes are not decoded here, so they are just invalid characters.
    'example.com%0aaddress=/evil.example/6.6.6.6',
  ];
  for (const domain of injections) {
    assert.equal(
      isValidDomain(domain),
      false,
      `accepted ${JSON.stringify(domain)}`
    );
  }
});

test('isValidDomain: rejects empty, whitespace-only and untrimmed input (callers must trim)', () => {
  assert.equal(isValidDomain(''), false);
  assert.equal(isValidDomain('.'), false);
  assert.equal(isValidDomain('   '), false);
  assert.equal(isValidDomain('\n'), false);
  assert.equal(isValidDomain(' example.com'), false);
  assert.equal(isValidDomain('example.com '), false);
  assert.equal(isValidDomain('example.com\n'), false);
});

test('isValidDomain: rejects malformed label boundaries', () => {
  assert.equal(isValidDomain('.example.com'), false);
  assert.equal(isValidDomain('example..com'), false);
  assert.equal(isValidDomain('-example.com'), false);
  assert.equal(isValidDomain('example-.com'), false);
  assert.equal(isValidDomain('example.-com'), false);
  assert.equal(isValidDomain('example.com-'), false);
  assert.equal(isValidDomain('under_score.example'), false);
  assert.equal(isValidDomain('_acme-challenge.example.com'), false);
});

test('isValidDomain: enforces the 63-character label and 253-character name limits', () => {
  const label = (n: number): string => 'a'.repeat(n);
  assert.equal(isValidDomain(`${label(63)}.example`), true);
  assert.equal(isValidDomain(`${label(64)}.example`), false);

  const name253 = `${label(61)}.`.repeat(4) + label(5);
  assert.equal(name253.length, 253);
  assert.equal(isValidDomain(name253), true);
  assert.equal(isValidDomain(`${name253}a`), false);
  // The root dot is stripped before measuring, so it does not cost a character.
  assert.equal(isValidDomain(`${name253}.`), true);
});

test('isValidDomain: rejects raw unicode but accepts its punycode (LDH) form', () => {
  assert.equal(isValidDomain('bücher.example'), false);
  assert.equal(isValidDomain('例え.テスト'), false);
  assert.equal(isValidDomain('🔥.example'), false);
  assert.equal(isValidDomain('xn--bcher-kva.example'), true);
  assert.equal(isValidDomain('xn--r8jz45g.xn--zckzah'), true);
});

test('isValidDomain: a unicode character that case-folds to ASCII is refused', () => {
  // U+212A KELVIN SIGN lowercases to 'k'. Validating the lowercased form would
  // accept this and then block `kelvin.example` - a name the user never typed.
  // Built from its code point so it cannot be misread as an ASCII 'K'.
  const kelvinSign = String.fromCharCode(0x212a);
  const domain = `${kelvinSign}elvin.example`;
  assert.notEqual(domain, 'Kelvin.example');
  assert.equal(isValidDomain(domain), false);
  // The normalizer still folds it - which is exactly why the guard has to run
  // on the input, before normalization, rather than after.
  assert.equal(normalizeDomain(domain), 'kelvin.example');
  assert.equal(
    appendBlacklistDomain('', domain),
    'address=/kelvin.example/0.0.0.0\naddress=/kelvin.example/::\n'
  );
});

test('isValidDomain: every accepted domain survives into a single well-formed address= pair', () => {
  for (const domain of [
    'Example.COM.',
    'a.b.example',
    '1.2.3.4',
    'x'.repeat(63),
  ]) {
    const lines = appendBlacklistDomain('', domain).split('\n').slice(0, -1);
    assert.equal(isValidDomain(domain), true);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.match(line, /^address=\/[a-z0-9.-]+\/(0\.0\.0\.0|::)$/);
    }
  }
});

test('normalizeDomain: lowercases and drops exactly one trailing dot', () => {
  assert.equal(normalizeDomain('Example.COM'), 'example.com');
  assert.equal(normalizeDomain('Example.COM.'), 'example.com');
  assert.equal(normalizeDomain('example.com..'), 'example.com.');
  assert.equal(normalizeDomain('.'), '');
  assert.equal(normalizeDomain(''), '');
  // No trimming: whitespace is preserved for the validator to reject.
  assert.equal(normalizeDomain(' Example.COM '), ' example.com ');
});

test('isDomainOrSubdomain: matches the name itself and any subdomain, never a suffix lookalike', () => {
  assert.equal(isDomainOrSubdomain('example.com', 'example.com'), true);
  assert.equal(isDomainOrSubdomain('API.Example.com.', 'example.com'), true);
  assert.equal(isDomainOrSubdomain('a.b.example.com', 'example.com'), true);
  assert.equal(isDomainOrSubdomain('notexample.com', 'example.com'), false);
  assert.equal(isDomainOrSubdomain('xexample.com', 'example.com'), false);
  // The parent is a suffix of the child, not the other way round.
  assert.equal(
    isDomainOrSubdomain('example.com.evil.test', 'example.com'),
    false
  );
  assert.equal(isDomainOrSubdomain('example.com', 'a.example.com'), false);
});

test('isDomainOrSubdomain: both sides are normalized', () => {
  assert.equal(isDomainOrSubdomain('example.com', 'Example.com'), true);
  assert.equal(isDomainOrSubdomain('a.example.com', 'example.com.'), true);
});

test('isLocalhost: localhost and localhost.localdomain, plus their subdomains', () => {
  assert.equal(isLocalhost('localhost'), true);
  assert.equal(isLocalhost('LOCALHOST.'), true);
  assert.equal(isLocalhost('api.localhost'), true);
  assert.equal(isLocalhost('localhost.localdomain'), true);
  assert.equal(isLocalhost('notlocalhost'), false);
  assert.equal(isLocalhost('localhost.example.com'), false);
  assert.equal(isLocalhost('example.com'), false);
});
