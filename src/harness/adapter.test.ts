import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeCodeAdapter,
  codexAdapter,
  piAdapter,
  renderCodexConfig,
  renderCodexMcpServers,
  renderPiMcpServers,
  renderPiModelsJson,
  piApi,
  PI_PROVIDER_ID,
  validateProviderProtocol,
  EnvFileRenderer,
  parseDotenv,
  filterEnvContent,
  type Provider,
} from './adapter.js';

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

test('renderCodexConfig: omits the model line for `auto` (delivered at runtime, not baked)', () => {
  const toml = renderCodexConfig({ ...codexProvider, model: 'auto' });
  assert.match(toml, /^model = /m);
  assert.match(toml, /^model_provider = "e"$/m);
  assert.match(toml, /^base_url = /m);
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
  const file = codexAdapter.renderProviderFile(codexProvider, {});
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
  const base = renderCodexConfig(codexProvider);
  const overlay = codexAdapter.planConfigOverlay!(base, [
    { name: 'everything', url: 'http://everything:3001/mcp' },
  ]);
  assert.equal(overlay.file.fileName, 'config.toml');
  // The adapter owns where the file mounts and how the config dir is relocated.
  assert.equal(overlay.mountTo, '/home/node/.codex/config.toml');
  assert.deepEqual(overlay.env, ['CODEX_HOME=/home/node/.codex']);
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
test('renderPiMcpServers: renders a standard mcpServers JSON block with url entries', () => {
  const json = renderPiMcpServers([
    { name: 'everything', url: 'http://everything:3001/mcp' },
    { name: 'filesystem', url: 'http://filesystem:8000/mcp' },
  ]);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed.mcpServers.everything, {
    url: 'http://everything:3001/mcp',
  });
  assert.deepEqual(parsed.mcpServers.filesystem, {
    url: 'http://filesystem:8000/mcp',
  });
});
test('renderPiMcpServers: renders remote headers verbatim in the entry', () => {
  const json = renderPiMcpServers([
    {
      name: 'hosted',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer TOKEN' },
    },
  ]);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed.mcpServers.hosted, {
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer TOKEN' },
  });
});
test('renderPiMcpServers: an empty selection renders an empty mcpServers map', () => {
  assert.deepEqual(JSON.parse(renderPiMcpServers([])), { mcpServers: {} });
});
test('piAdapter.planConfigOverlay: produces a mcp.json overlay mounted in the pi config dir', () => {
  const overlay = piAdapter.planConfigOverlay!('', [
    { name: 'everything', url: 'http://everything:3001/mcp' },
  ]);
  assert.equal(overlay.file.fileName, 'mcp.json');
  assert.equal(overlay.mountTo, '/home/node/.pi/agent/mcp.json');
  assert.deepEqual(overlay.env, []);
  const parsed = JSON.parse(overlay.file.content);
  assert.deepEqual(parsed.mcpServers.everything, {
    url: 'http://everything:3001/mcp',
  });
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
  const cfg = JSON.parse(renderPiModelsJson(piProvider, {}));
  const p = cfg.providers[PI_PROVIDER_ID];
  assert.equal(p.baseUrl, 'https://gateway.example.com/v1');
  assert.equal(p.api, 'anthropic-messages');
  // pi requires the model declared in the file to select it.
  assert.deepEqual(p.models, [{ id: 'claude-opus-5' }]);
});

test('renderPiModelsJson: references the API key by env var name via ${VAR}, never a value', () => {
  const cfg = JSON.parse(renderPiModelsJson(piProvider, {}));
  // pi interpolates ${VAR} from the process env at request time; the baked file
  // must carry the name, never a secret.
  assert.equal(cfg.providers[PI_PROVIDER_ID].apiKey, '');
});

test('renderPiModelsJson: maps openai-chat to pi openai-completions', () => {
  const cfg = JSON.parse(
    renderPiModelsJson({ ...piProvider, protocol: 'openai-chat' }, {})
  );
  assert.equal(cfg.providers[PI_PROVIDER_ID].api, 'openai-completions');
});

test('piAdapter: is a file-delivered adapter that renders models.json', () => {
  assert.equal(piAdapter.kind, 'file');
  const file = piAdapter.renderProviderFile(piProvider, {});
  assert.equal(file.fileName, 'models.json');
  assert.equal(file.content, renderPiModelsJson(piProvider, {}));
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

test('piAdapter: ships MCP delivery via the pi-mcp-adapter (mcp.json overlay)', () => {
  assert.equal(typeof piAdapter.planConfigOverlay, 'function');
  // pi's overlay is self-contained (the provider models.json stays baked); the
  // adapter does not render MCP into the provider file, so renderMcpServers is
  // intentionally absent.
  assert.equal(piAdapter.renderMcpServers, undefined);
});
