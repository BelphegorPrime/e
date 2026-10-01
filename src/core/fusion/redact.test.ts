import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secretRedactor } from './redact.js';

/*
 * Known secrets out of what a fusion keeps and hands on (#180): a key one
 * candidate printed into its worktree must not reach the synthesizer's
 * provider, nor sit in the record for 14 days.
 */

const env = {
  OPENAI_API_KEY: 'sk-live-0123456789',
  GITHUB_TOKEN: 'ghp_abcdefghij',
  JWT_SECRET: 'short',
  OPENAI_BASE_URL: 'http://localhost:20128/v1',
  MODEL: 'auto/coding',
  CUSTOM_PROVIDER_CRED: 'cred-value-123456',
  GIT_AUTHOR_EMAIL: 'someone@example.invalid',
  KEYBOARD_LAYOUT: 'de-nodeadkeys',
};

test('secretRedactor: values of secret-looking keys and of the named keys become placeholders', () => {
  const redact = secretRedactor(env, ['CUSTOM_PROVIDER_CRED']);
  assert.equal(
    redact.text(
      'key=sk-live-0123456789 token ghp_abcdefghij cred=cred-value-123456'
    ),
    'key=[redacted:OPENAI_API_KEY] token [redacted:GITHUB_TOKEN] cred=[redacted:CUSTOM_PROVIDER_CRED]'
  );
  // Not secrets: a base URL or a model id in a patch is code, not a leak.
  assert.equal(
    redact.text('fetch("http://localhost:20128/v1", { model: "auto/coding" })'),
    'fetch("http://localhost:20128/v1", { model: "auto/coding" })'
  );
  // Too short to replace without mangling ordinary text.
  assert.equal(redact.text('short'), 'short');
  // A name with KEY or AUTH inside a word is not a secret's.
  assert.equal(
    redact.text('someone@example.invalid de-nodeadkeys'),
    'someone@example.invalid de-nodeadkeys'
  );
  assert.equal(redact.empty, false);
});

test('secretRedactor: bytes too, binary or not, every occurrence', () => {
  const redact = secretRedactor(env);
  const input = Buffer.concat([
    Buffer.from([0, 1, 2]),
    Buffer.from('sk-live-0123456789'),
    Buffer.from(' and sk-live-0123456789'),
  ]);
  const out = redact.bytes(input);
  assert.equal(
    out.toString('latin1'),
    '\u0000\u0001\u0002[redacted:OPENAI_API_KEY] and [redacted:OPENAI_API_KEY]'
  );
  const clean = Buffer.from('nothing here');
  assert.equal(redact.bytes(clean), clean, 'untouched input is returned as is');
});

test('secretRedactor: a longer secret wins over one it contains', () => {
  const redact = secretRedactor({
    A_KEY: 'abcdefgh',
    B_KEY: 'xxabcdefghxx',
  });
  assert.equal(
    redact.text('xxabcdefghxx abcdefgh'),
    '[redacted:B_KEY] [redacted:A_KEY]'
  );
});

test('secretRedactor: nothing known, nothing to do', () => {
  const redact = secretRedactor({});
  assert.equal(redact.empty, true);
  assert.equal(redact.text('sk-live-0123456789'), 'sk-live-0123456789');
});
