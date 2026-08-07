import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from './slugify';

test('lowercases and hyphenates spaces', () => {
  assert.equal(slugify('Create Cool Feature'), 'create-cool-feature');
});

test('collapses runs of non-alphanumerics to a single hyphen', () => {
  assert.equal(slugify('add   OAuth2 / SSO!!!'), 'add-oauth2-sso');
});

test('trims leading and trailing hyphens', () => {
  assert.equal(slugify('  --fix the bug--  '), 'fix-the-bug');
});

test('handles multi-line prompts', () => {
  assert.equal(slugify('first line\nsecond line'), 'first-line-second-line');
});

test('falls back to "run" when nothing usable remains', () => {
  assert.equal(slugify('!!!'), 'run');
  assert.equal(slugify(''), 'run');
});
