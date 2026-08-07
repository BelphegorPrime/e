import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from './slugify';

test('lowercases and hyphenates spaces', () => {
  assert.equal(slugify('Create Cool Feature'), 'create-cool-feature');
});

test('collapses runs of non-alphanumerics to a single hyphen', () => {
  assert.equal(slugify('add   OAuth2 / SSO'), 'add-oauth2-sso');
});

test('trims leading and trailing hyphens', () => {
  assert.equal(slugify('  ...fix broken parser...  '), 'fix-broken-parser');
});

test('handles multi-line prompts', () => {
  assert.equal(slugify('first line\nsecond thing'), 'first-line-second-thing');
});

test('falls back to "run" when nothing usable remains', () => {
  assert.equal(slugify('!!!'), 'run');
  assert.equal(slugify(''), 'run');
});

test('drops stop-words', () => {
  assert.equal(
    slugify('Create a cool feature that improves usability'),
    'create-cool-feature-improves-usability',
  );
});

test('falls back to "run" when only stop-words remain', () => {
  assert.equal(slugify('the of a to'), 'run');
});

test('truncates to a word boundary under ~40 chars', () => {
  const slug = slugify(
    'refactor authentication middleware pipeline configuration loader',
  );
  assert.ok(slug.length <= 40, `expected <=40 chars, got ${slug.length}: ${slug}`);
  // Truncation happens at a word boundary: no dangling hyphen, no partial word.
  assert.ok(!slug.endsWith('-'));
  assert.ok(!slug.startsWith('-'));
  assert.ok(
    'refactor-authentication-middleware-pipeline-configuration-loader'.startsWith(
      slug,
    ),
    `slug "${slug}" should be a whole-word prefix`,
  );
});

test('keeps a single over-long word whole rather than emitting nothing', () => {
  const long = 'supercalifragilisticexpialidocioussupercalifragilistic';
  assert.equal(slugify(long), long);
});

test('numbers are preserved as alphanumerics', () => {
  assert.equal(slugify('bump to v2 release'), 'bump-v2-release');
});
