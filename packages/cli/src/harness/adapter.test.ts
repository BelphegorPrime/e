import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeCodeAdapter,
  validateProviderProtocol,
  renderProviderEnvFile,
  parseDotenv,
  type Provider,
} from './adapter';

const provider: Provider = {
  baseUrl: 'https://gateway.example.com',
  model: 'claude-opus-5',
  protocol: 'anthropic-messages',
  apiKeyEnv: 'MY_GATEWAY_KEY',
};

test('validateProviderProtocol: a matching protocol passes', () => {
  assert.doesNotThrow(() =>
    validateProviderProtocol(provider, {
      name: 'claudeCode',
      protocols: ['anthropic-messages'],
    }),
  );
});

test('validateProviderProtocol: an absent provider always passes', () => {
  assert.doesNotThrow(() =>
    validateProviderProtocol(undefined, {
      name: 'claudeCode',
      protocols: ['anthropic-messages'],
    }),
  );
});

test('validateProviderProtocol: a mismatch throws, naming the harness and its set', () => {
  const openaiProvider: Provider = { ...provider, protocol: 'openai-responses' };
  assert.throws(
    () =>
      validateProviderProtocol(openaiProvider, {
        name: 'claudeCode',
        protocols: ['anthropic-messages'],
      }),
    /claudeCode[\s\S]*openai-responses[\s\S]*anthropic-messages/,
  );
});

test('claudeCodeAdapter: renders base URL and model as literals, key by name', () => {
  const entries = claudeCodeAdapter.renderProviderEnv(provider);
  assert.deepEqual(entries, [
    { name: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example.com' },
    { name: 'ANTHROPIC_MODEL', value: 'claude-opus-5' },
    { name: 'ANTHROPIC_AUTH_TOKEN', fromEnv: 'MY_GATEWAY_KEY' },
  ]);
});

test('claudeCodeAdapter: never emits the secret value, only its env var name', () => {
  const entries = claudeCodeAdapter.renderProviderEnv(provider);
  const auth = entries.find((e) => e.name === 'ANTHROPIC_AUTH_TOKEN');
  assert.ok(auth && 'fromEnv' in auth);
  assert.ok(!('value' in auth));
});

test('renderProviderEnvFile: literals inline, fromEnv resolved from .e/.env', () => {
  const content = renderProviderEnvFile(
    claudeCodeAdapter.renderProviderEnv(provider),
    (name) => (name === 'MY_GATEWAY_KEY' ? 'sk-secret-123' : undefined),
  );
  assert.equal(
    content,
    [
      'ANTHROPIC_BASE_URL=https://gateway.example.com',
      'ANTHROPIC_MODEL=claude-opus-5',
      'ANTHROPIC_AUTH_TOKEN=sk-secret-123',
      '',
    ].join('\n'),
  );
});

test('renderProviderEnvFile: a missing key is a hard error naming the fix', () => {
  assert.throws(
    () =>
      renderProviderEnvFile(
        claudeCodeAdapter.renderProviderEnv(provider),
        () => undefined,
      ),
    /MY_GATEWAY_KEY[\s\S]*\.e\/\.env/,
  );
});

test('renderProviderEnvFile: an empty key value is rejected like a missing one', () => {
  assert.throws(
    () =>
      renderProviderEnvFile(
        claudeCodeAdapter.renderProviderEnv(provider),
        () => '',
      ),
    /not set in \.e\/\.env/,
  );
});

test('parseDotenv: parses KEY=VALUE, skips comments and blanks, keeps value verbatim', () => {
  const env = parseDotenv(
    [
      '# a comment',
      '',
      'ANTHROPIC_API_KEY=sk-abc',
      '  SPACED_KEY = value-with = signs ',
      'NO_EQUALS_LINE',
      'EMPTY=',
    ].join('\n'),
  );
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-abc');
  // Key is trimmed; value keeps everything after the first '=' verbatim.
  assert.equal(env.SPACED_KEY, ' value-with = signs ');
  assert.equal(env.EMPTY, '');
  assert.ok(!('NO_EQUALS_LINE' in env));
});
