import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeCodeAdapter,
  codexAdapter,
  piAdapter,
  renderCodexConfig,
  renderCodexMcpServers,
  renderPiModelsJson,
  piApi,
  PI_PROVIDER_ID,
  validateProviderProtocol,
  EnvFileRenderer,
  parseDotenv,
  type Provider,
} from './adapter';
import { SpawnFacts } from '../spawnPlan';
import { Harness } from '.';
import { Agent } from '../agent';

const provider: Provider = {
  baseUrl: 'https://gateway.example.com',
  model: 'claude-opus-5',
  protocol: 'anthropic-messages',
  apiKeyEnv: 'MY_GATEWAY_KEY',
};

const harness: Harness = {
  name: 'demo',
  imageTag: 'e-harness-demo',
  dockerfile: { label: 'demo', npmPackage: 'demo' },
  requiredEnv: [],
  protocols: [],
  buildCommand: (prompt: string) => ['demo', '-p', prompt],
};
const agent: Agent = { name: 'demo', harness: 'demo', tier: 'default' };

function facts(overrides: Partial<SpawnFacts> = {}): SpawnFacts {
  return {
    root: '/root',
    agent,
    harness,
    storeEnv: {},
    mcpServers: [],
    perRunSkills: [],
    bakedSkills: [],
    prompt: 'do it',
    rebuild: false,
    env: [],
    attach: true,
    ...overrides,
  };
}

test('validateProviderProtocol: a matching protocol passes', () => {
  assert.doesNotThrow(() =>
    validateProviderProtocol(provider, {
      name: 'claudeCode',
      protocols: ['anthropic-messages'],
    })
  );
});

test('validateProviderProtocol: an absent provider always passes', () => {
  assert.doesNotThrow(() =>
    validateProviderProtocol(undefined, {
      name: 'claudeCode',
      protocols: ['anthropic-messages'],
    })
  );
});

test('validateProviderProtocol: a mismatch throws, naming the harness and its set', () => {
  const openaiProvider: Provider = {
    ...provider,
    protocol: 'openai-responses',
  };
  assert.throws(
    () =>
      validateProviderProtocol(openaiProvider, {
        name: 'claudeCode',
        protocols: ['anthropic-messages'],
      }),
    /claudeCode[\s\S]*openai-responses[\s\S]*anthropic-messages/
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
  const auth = entries.find(e => e.name === 'ANTHROPIC_AUTH_TOKEN');
  assert.ok(auth && 'fromEnv' in auth);
  assert.ok(!('value' in auth));
});

test('EnvFileRenderer: literals inline, fromEnv resolved from .e/.env', () => {
  const renderer = new EnvFileRenderer(name =>
    name === 'MY_GATEWAY_KEY' ? 'sk-secret-123' : undefined
  );
  const content = renderer.render(
    claudeCodeAdapter.renderProviderEnv(provider),
    'Provider API key'
  );
  assert.equal(
    content,
    [
      'ANTHROPIC_BASE_URL=https://gateway.example.com',
      'ANTHROPIC_MODEL=claude-opus-5',
      'ANTHROPIC_AUTH_TOKEN=sk-secret-123',
      '',
    ].join('\n')
  );
});

test('EnvFileRenderer: a missing key is a hard error naming the subject and the fix', () => {
  const renderer = new EnvFileRenderer(() => undefined);
  assert.throws(
    () =>
      renderer.render(
        claudeCodeAdapter.renderProviderEnv(provider),
        'Provider API key'
      ),
    /Provider API key[\s\S]*MY_GATEWAY_KEY[\s\S]*\.e\/\.env/
  );
});

test('EnvFileRenderer: an empty key value is rejected like a missing one', () => {
  const renderer = new EnvFileRenderer(() => '');
  assert.throws(
    () =>
      renderer.render(
        claudeCodeAdapter.renderProviderEnv(provider),
        'Provider API key'
      ),
    /not set in \.e\/\.env/
  );
});

test('EnvFileRenderer: the same instance renders many files with a per-call subject', () => {
  const renderer = new EnvFileRenderer(name =>
    name === 'TOKEN' ? 'v' : undefined
  );
  assert.equal(
    renderer.render([{ name: 'API', fromEnv: 'TOKEN' }], 'MCP server "x"'),
    'API=v\n'
  );
  assert.throws(
    () =>
      renderer.render([{ name: 'API', fromEnv: 'MISSING' }], 'MCP server "x"'),
    /MCP server "x"[\s\S]*MISSING/
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
    ].join('\n')
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
  const toml = renderCodexConfig(facts(), codexProvider);
  // The custom provider is selected at the top level...
  assert.match(toml, /^model = "gpt-5-codex"$/m);
  assert.match(toml, /^model_provider = "e"$/m);
  // ...and defined as a Responses provider pointing at the custom base URL.
  assert.match(toml, /^\[model_providers\.e\]$/m);
  assert.match(toml, /^base_url = "https:\/\/gateway\.example\.com\/v1"$/m);
  assert.match(toml, /^wire_api = "responses"$/m);
});

test('renderCodexConfig: references the API key by env var name, never a value', () => {
  const toml = renderCodexConfig(facts(), codexProvider);
  // Codex reads the key from the env var named by `env_key` at runtime; the
  // rendered file (baked into the image) must carry the name, never a secret.
  assert.match(toml, /^env_key = "MY_GATEWAY_KEY"$/m);
});

test('renderCodexConfig: omits the model line for `auto` (delivered at runtime, not baked)', () => {
  const toml = renderCodexConfig(facts(), { ...codexProvider, model: 'auto' });
  // No top-level `model =` (it arrives via `codex exec -m` at spawn)...
  assert.doesNotMatch(toml, /^model = /m);
  // ...but the provider block is still baked so the endpoint is selected.
  assert.match(toml, /^model_provider = "e"$/m);
  assert.match(toml, /^base_url = /m);
});

test('renderCodexConfig: escapes TOML-significant characters in interpolated values', () => {
  const toml = renderCodexConfig(facts(), {
    ...codexProvider,
    baseUrl: 'https://host/"weird"\\path',
  });
  // The rendered base_url stays a valid TOML basic string: quotes and
  // backslashes are escaped rather than closing the literal.
  assert.match(toml, /^base_url = "https:\/\/host\/\\"weird\\"\\\\path"$/m);
});

test('codexAdapter: is a file-delivered adapter that renders config.toml', () => {
  assert.equal(codexAdapter.kind, 'file');
  const file = codexAdapter.renderProviderFile(facts(), codexProvider);
  assert.equal(file.fileName, 'config.toml');
  assert.equal(file.content, renderCodexConfig(facts(), codexProvider));
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
  assert.ok(entries.every(e => 'fromEnv' in e && !('value' in e)));
});

test('renderCodexMcpServers: renders a streamable-HTTP block per server (url, no type key)', () => {
  const toml = renderCodexMcpServers([
    { name: 'everything', url: 'http://everything:3001/mcp' },
    { name: 'filesystem', url: 'http://filesystem:8000/mcp' },
  ]);
  assert.match(toml, /^\[mcp_servers\.everything\]$/m);
  assert.match(toml, /^url = "http:\/\/everything:3001\/mcp"$/m);
  assert.match(toml, /^\[mcp_servers\.filesystem\]$/m);
  assert.match(toml, /^url = "http:\/\/filesystem:8000\/mcp"$/m);
  // Streamable HTTP is denoted by the presence of `url`; no transport/type key.
  assert.doesNotMatch(toml, /transport|type =/);
});

test('renderCodexMcpServers: an empty selection renders nothing', () => {
  assert.equal(renderCodexMcpServers([]), '');
});

test('renderCodexMcpServers: renders remote headers verbatim as http_headers', () => {
  const toml = renderCodexMcpServers([
    {
      name: 'hosted',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer TOKEN' },
    },
  ]);
  assert.match(
    toml,
    /^http_headers = \{ "Authorization" = "Bearer TOKEN" \}$/m
  );
});

test('codexAdapter: renderMcpServers delegates to renderCodexMcpServers', () => {
  const endpoints = [{ name: 'everything', url: 'http://everything:3001/mcp' }];
  assert.equal(
    codexAdapter.renderMcpServers!(endpoints),
    renderCodexMcpServers(endpoints)
  );
});

test('codexAdapter.planConfigOverlay: merges the MCP block onto the baked base config', () => {
  const base = renderCodexConfig(facts(), codexProvider);
  const overlay = codexAdapter.planConfigOverlay!(base, [
    { name: 'everything', url: 'http://everything:3001/mcp' },
  ]);
  assert.equal(overlay.file.fileName, 'config.toml');
  // The adapter owns where the file mounts and how the config dir is relocated.
  assert.equal(overlay.mountTo, '/root/.codex/config.toml');
  assert.deepEqual(overlay.env, ['CODEX_HOME=/root/.codex']);
  // The baked provider block is preserved...
  assert.match(overlay.file.content, /^model_provider = "e"$/m);
  assert.match(overlay.file.content, /^base_url = /m);
  // ...and the MCP server block is appended.
  assert.match(overlay.file.content, /^\[mcp_servers\.everything\]$/m);
  assert.match(
    overlay.file.content,
    /^url = "http:\/\/everything:3001\/mcp"$/m
  );
  // A blank line separates the two sections (valid TOML, readable).
  assert.match(
    overlay.file.content,
    /wire_api = "responses"\n\n\[mcp_servers\.everything\]/
  );
});

test('codexAdapter.planConfigOverlay: a default agent (no base) yields an MCP-only config', () => {
  const overlay = codexAdapter.planConfigOverlay!('', [
    { name: 'everything', url: 'http://everything:3001/mcp' },
  ]);
  assert.doesNotMatch(overlay.file.content, /model_provider/);
  assert.match(overlay.file.content, /^\[mcp_servers\.everything\]$/m);
  // No leading blank lines when there is no base config.
  assert.match(overlay.file.content, /^\[mcp_servers\.everything\]/);
});

const piProvider: Provider = {
  baseUrl: 'https://gateway.example.com/v1',
  model: 'claude-opus-5',
  protocol: 'anthropic-messages',
  apiKeyEnv: 'MY_GATEWAY_KEY',
};

test('piApi: maps e wire protocols to pi api names (two differ)', () => {
  assert.equal(piApi('anthropic-messages'), 'anthropic-messages');
  assert.equal(piApi('openai-chat'), 'openai-completions');
  assert.equal(piApi('openai-responses'), 'openai-responses');
});

test('renderPiModelsJson: renders a single custom provider selecting the endpoint and model', () => {
  const cfg = JSON.parse(renderPiModelsJson(facts(), piProvider));
  const p = cfg.providers[PI_PROVIDER_ID];
  assert.equal(p.baseUrl, 'https://gateway.example.com/v1');
  assert.equal(p.api, 'anthropic-messages');
  // pi requires the model declared in the file to select it.
  assert.deepEqual(p.models, [{ id: 'claude-opus-5' }]);
});

test('renderPiModelsJson: references the API key by env var name via ${VAR}, never a value', () => {
  const cfg = JSON.parse(renderPiModelsJson(facts(), piProvider));
  // pi interpolates ${VAR} from the process env at request time; the baked file
  // must carry the name, never a secret.
  assert.equal(cfg.providers[PI_PROVIDER_ID].apiKey, '${MY_GATEWAY_KEY}');
});

test('renderPiModelsJson: maps openai-chat to pi openai-completions', () => {
  const cfg = JSON.parse(
    renderPiModelsJson(facts(), { ...piProvider, protocol: 'openai-chat' })
  );
  assert.equal(cfg.providers[PI_PROVIDER_ID].api, 'openai-completions');
});

test('piAdapter: is a file-delivered adapter that renders models.json', () => {
  assert.equal(piAdapter.kind, 'file');
  const file = piAdapter.renderProviderFile(facts(), piProvider);
  assert.equal(file.fileName, 'models.json');
  assert.equal(file.content, renderPiModelsJson(facts(), piProvider));
});

test('piAdapter: bakes config under a relocated config dir outside /workspace', () => {
  assert.equal(piAdapter.configDirEnv, 'PI_CODING_AGENT_DIR');
  assert.ok(piAdapter.configDir.startsWith('/'));
  assert.ok(!piAdapter.configDir.startsWith('/workspace'));
});

test('piAdapter: requires the model in the file; Codex does not (modelInFile)', () => {
  // pi selects only models declared in models.json, so a resolved model is always
  // baked; Codex can deliver an auto model on the command line via `-m`.
  assert.equal(piAdapter.modelInFile, true);
  assert.equal(codexAdapter.modelInFile, false);
});

test('piAdapter: the only runtime env is the API key, delivered by name', () => {
  assert.deepEqual(piAdapter.renderRuntimeEnv(piProvider), [
    { name: 'MY_GATEWAY_KEY', fromEnv: 'MY_GATEWAY_KEY' },
  ]);
});

test('piAdapter: ships no MCP delivery (pi has no MCP client)', () => {
  assert.equal(piAdapter.planConfigOverlay, undefined);
  assert.equal(piAdapter.renderMcpServers, undefined);
});
