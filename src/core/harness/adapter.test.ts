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
  type FileHarnessAdapter,
  type Provider,
} from './adapter.js';
import { planAgentImage, planProviderDelivery } from './deriveImage.js';

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

test('renderCodexConfig: bakes an `auto` alias verbatim (the endpoint resolves it)', () => {
  const toml = renderCodexConfig({ ...codexProvider, model: 'auto/coding' });
  assert.match(toml, /^model = "auto\/coding"$/m);
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

test('codexAdapter: one call plans the whole delivery - a baked config.toml, the key by name', () => {
  assert.equal(codexAdapter.kind, 'file');
  const delivery = codexAdapter.planProviderDelivery(codexProvider, {});
  assert.equal(delivery.bakedConfig.file.fileName, 'config.toml');
  assert.equal(
    delivery.bakedConfig.file.content,
    renderCodexConfig(codexProvider)
  );
  // The only runtime env is the API key, delivered by name.
  assert.deepEqual(delivery.runtimeEnv, [
    { name: 'MY_GATEWAY_KEY', fromEnv: 'MY_GATEWAY_KEY' },
  ]);
});

test('codexAdapter: bakes config under a relocated config dir outside /workspace', () => {
  const { bakedConfig } = codexAdapter.planProviderDelivery(codexProvider, {});
  assert.equal(bakedConfig.configDirEnv, 'CODEX_HOME');
  assert.ok(bakedConfig.configDir.startsWith('/'));
  assert.ok(!bakedConfig.configDir.startsWith('/workspace'));
});

test('codexAdapter: the runtime env never carries the secret value, only its name', () => {
  const { runtimeEnv } = codexAdapter.planProviderDelivery(codexProvider, {});
  assert.ok(runtimeEnv.every(e => 'fromEnv' in e && !('value' in e)));
});

test('codexAdapter: names the model on the run command only for an auto pick', () => {
  // A concrete model is selected by the baked config.toml; the `auto` alias is
  // not a model the baked line can select, so it goes on `codex exec -m`.
  assert.equal(
    codexAdapter.planProviderDelivery(codexProvider, {}).runtimeModel,
    undefined
  );
  assert.equal(
    codexAdapter.planProviderDelivery(
      { ...codexProvider, model: 'auto/coding' },
      {}
    ).runtimeModel,
    'auto/coding'
  );
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

test('codexAdapter.planConfigOverlay: merges the MCP block onto the baked base config', () => {
  const base = renderCodexConfig(codexProvider);
  const overlay = codexAdapter.planConfigOverlay!(base, [
    { name: 'everything', url: 'http://everything:3001/mcp' },
  ]);
  assert.equal(overlay.file.fileName, 'config.toml');
  // The adapter owns where the file mounts and how the config dir is relocated.
  assert.equal(overlay.mountTo, '/home/node/.codex/config.toml');
  // Named variable and value, not a formatted argv entry: the spawn edge
  // decides how the engine spells an env entry.
  assert.deepEqual(overlay.env, [
    { name: 'CODEX_HOME', value: '/home/node/.codex' },
  ]);
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

test('piAdapter: one call plans the whole delivery - a baked models.json, the key by name', () => {
  assert.equal(piAdapter.kind, 'file');
  const delivery = piAdapter.planProviderDelivery(piProvider, {});
  assert.equal(delivery.bakedConfig.file.fileName, 'models.json');
  assert.equal(
    delivery.bakedConfig.file.content,
    renderPiModelsJson(piProvider, {})
  );
  // The only runtime env is the API key, delivered by name.
  assert.deepEqual(delivery.runtimeEnv, [
    { name: 'MY_GATEWAY_KEY', fromEnv: 'MY_GATEWAY_KEY' },
  ]);
});

test('piAdapter: bakes config under a relocated config dir outside /workspace', () => {
  const { bakedConfig } = piAdapter.planProviderDelivery(piProvider, {});
  assert.equal(bakedConfig.configDirEnv, 'PI_CODING_AGENT_DIR');
  assert.ok(bakedConfig.configDir.startsWith('/'));
  assert.ok(!bakedConfig.configDir.startsWith('/workspace'));
});

test('piAdapter: names every model on the run command; Codex only an auto pick', () => {
  // pi selects by flag and only from what models.json declares, so the model is
  // baked *and* named on the command line; Codex lets a concrete model stand.
  assert.equal(
    piAdapter.planProviderDelivery(piProvider, {}).runtimeModel,
    'claude-opus-5'
  );
  assert.equal(
    codexAdapter.planProviderDelivery(codexProvider, {}).runtimeModel,
    undefined
  );
});

test('piAdapter: ships MCP delivery via the pi-mcp-adapter (mcp.json overlay)', () => {
  // pi's overlay is self-contained: the baked models.json stays as it is and the
  // overlay mounts a sibling mcp.json, so nothing is merged into the provider file.
  assert.equal(typeof piAdapter.planConfigOverlay, 'function');
});

test('a file harness is one object: `kind` plus one delivery method', () => {
  // The whole contract, written out - a harness with no MCP overlay declares
  // nothing else. Nothing outside the adapter asks where its config dir is, what
  // its file is called, or whether its model may be baked, so this toy adapter
  // runs the full path from Provider to derived Dockerfile unchanged.
  const toyAdapter: FileHarnessAdapter = {
    kind: 'file',
    planProviderDelivery: provider => ({
      bakedConfig: {
        file: {
          fileName: 'toy.json',
          content: JSON.stringify({ model: provider.model }) + '\n',
        },
        configDir: '/home/node/.toy',
        configDirEnv: 'TOY_HOME',
      },
      runtimeEnv: [{ name: 'TOY_KEY', fromEnv: provider.apiKeyEnv }],
    }),
  };

  const delivery = planProviderDelivery({}, toyAdapter, codexProvider);
  assert.deepEqual(delivery.runtimeEnv, [
    { name: 'TOY_KEY', fromEnv: 'MY_GATEWAY_KEY' },
  ]);
  assert.equal(delivery.runtimeModel, undefined);

  const image = planAgentImage({
    baseImage: 'e-harness-toy',
    agentName: 'toy',
    bakedConfig: delivery.bakedConfig,
  });
  assert.ok(image);
  assert.deepEqual(
    image.files.map(f => f.fileName),
    ['toy.json', 'Dockerfile']
  );
  const dockerfile = image.files.find(f => f.fileName === 'Dockerfile');
  assert.match(
    dockerfile?.content ?? '',
    /^ENV TOY_HOME=\/home\/node\/\.toy$/m
  );
  assert.match(
    dockerfile?.content ?? '',
    /^COPY toy\.json \/home\/node\/\.toy\/toy\.json$/m
  );
});
