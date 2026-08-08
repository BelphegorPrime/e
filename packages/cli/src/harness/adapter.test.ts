import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeCodeAdapter,
  codexAdapter,
  renderCodexConfig,
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
  // The line is trimmed, then the value keeps everything after the first '='.
  assert.equal(env.SPACED_KEY, ' value-with = signs');
  assert.equal(env.EMPTY, '');
  assert.ok(!('NO_EQUALS_LINE' in env));
});

const codexProvider: Provider = {
  baseUrl: 'https://gateway.example.com/v1',
  model: 'gpt-5-codex',
  protocol: 'openai-responses',
  apiKeyEnv: 'MY_GATEWAY_KEY',
};

test('renderCodexConfig: renders a Responses provider block selecting a custom endpoint', () => {
  const toml = renderCodexConfig(codexProvider);
  // The custom provider is selected at the top level...
  assert.match(toml, /^model = "gpt-5-codex"$/m);
  assert.match(toml, /^model_provider = "e"$/m);
  // ...and defined as a Responses provider pointing at the custom base URL.
  assert.match(toml, /^\[model_providers\.e\]$/m);
  assert.match(toml, /^base_url = "https:\/\/gateway\.example\.com\/v1"$/m);
  assert.match(toml, /^wire_api = "responses"$/m);
});

test('renderCodexConfig: references the API key by env var name, never a value', () => {
  const toml = renderCodexConfig(codexProvider);
  // Codex reads the key from the env var named by `env_key` at runtime; the
  // rendered file (baked into the image) must carry the name, never a secret.
  assert.match(toml, /^env_key = "MY_GATEWAY_KEY"$/m);
});

test('renderCodexConfig: refuses to bake an `auto` model (resolved at spawn, not baked)', () => {
  assert.throws(
    () => renderCodexConfig({ ...codexProvider, model: 'auto' }),
    /auto/,
  );
});

test('renderCodexConfig: escapes TOML-significant characters in interpolated values', () => {
  const toml = renderCodexConfig({
    ...codexProvider,
    baseUrl: 'https://host/"weird"\\path',
  });
  // The rendered base_url stays a valid TOML basic string: quotes and
  // backslashes are escaped rather than closing the literal.
  assert.match(toml, /^base_url = "https:\/\/host\/\\"weird\\"\\\\path"$/m);
});

test('codexAdapter: is a file-delivered adapter that renders config.toml', () => {
  assert.equal(codexAdapter.kind, 'file');
  const file = codexAdapter.renderProviderFile(codexProvider);
  assert.equal(file.fileName, 'config.toml');
  assert.equal(file.content, renderCodexConfig(codexProvider));
});

test('codexAdapter: bakes config under a relocated config dir outside /workspace', () => {
  assert.equal(codexAdapter.configDirEnv, 'CODEX_HOME');
  assert.ok(codexAdapter.configDir.startsWith('/'));
  assert.ok(!codexAdapter.configDir.startsWith('/workspace'));
});

test('codexAdapter: the only runtime env is the API key, delivered by name', () => {
  const entries = codexAdapter.renderRuntimeEnv(codexProvider);
  assert.deepEqual(entries, [
    { name: 'MY_GATEWAY_KEY', fromEnv: 'MY_GATEWAY_KEY' },
  ]);
});

test('codexAdapter: the runtime env never carries the secret value, only its name', () => {
  const entries = codexAdapter.renderRuntimeEnv(codexProvider);
  assert.ok(entries.every((e) => 'fromEnv' in e && !('value' in e)));
});
