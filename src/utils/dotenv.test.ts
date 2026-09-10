import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDotenv, filterEnvContent } from './dotenv.js';

test('parseDotenv: parses KEY=VALUE, skips comments and blanks, keeps value verbatim', () => {
  const env = parseDotenv(
    [
      '# a comment',
      '',
      'ANTHROPIC_API_KEY=sk-abc',
      '  SPACED_KEY = value-with = signs ',
      'NO_EQUALS_LINE',
      'EMPTY=',
    ].join('\n')
  );
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-abc');
  // The line is trimmed, then the value keeps everything after the first '='.
  assert.equal(env.SPACED_KEY, ' value-with = signs');
  assert.equal(env.EMPTY, '');
  assert.ok(!('NO_EQUALS_LINE' in env));
});

test('filterEnvContent: keeps whitelisted keys verbatim, drops every other key', () => {
  const filtered = filterEnvContent(
    [
      '# a comment',
      '',
      'ANTHROPIC_BASE_URL=http://localhost:20128',
      'MY_GATEWAY_KEY=  sk-with = spaces',
      'SECRET_TOKEN=hunter2',
      'JUNK=must-not-leak',
    ].join('\n'),
    ['ANTHROPIC_BASE_URL', 'MY_GATEWAY_KEY']
  );
  // Allowed keys survive with their values verbatim, in source order; comments
  // and blanks are dropped (the output is a container env-file, not a human file).
  assert.equal(
    filtered,
    [
      'ANTHROPIC_BASE_URL=http://localhost:20128',
      'MY_GATEWAY_KEY=  sk-with = spaces',
      '',
    ].join('\n')
  );
  // Unknown secrets never leak into the output.
  assert.doesNotMatch(filtered, /SECRET_TOKEN|JUNK/);
});

test('filterEnvContent: an empty whitelist yields an empty env-file', () => {
  assert.equal(filterEnvContent('A=1\nB=2\n', []), '');
});

test('filterEnvContent: a duplicate key collapses to the last value, docker-style', () => {
  const filtered = filterEnvContent('IDENTITY=first\nIDENTITY=second\n', [
    'IDENTITY',
  ]);
  assert.equal(filtered, 'IDENTITY=second\n');
});