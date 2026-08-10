import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderDerivedDockerfile,
  derivedImageTag,
  planProviderDelivery,
  planAgentImage,
} from './deriveImage';
import { claudeCodeAdapter, codexAdapter, piAdapter, type Provider } from './adapter';
import { Harness } from '.';
import { Agent } from '../agent';
import { SpawnFacts } from '../spawnPlan';

const providerBlock = {
  configFileName: 'config.toml',
  configDir: '/root/.codex',
  configDirEnv: 'CODEX_HOME',
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

test('renderDerivedDockerfile: builds FROM the harness base image (layer-2 reuse)', () => {
  const dockerfile = renderDerivedDockerfile({
    baseImage: 'e-harness-codex',
    provider: providerBlock,
  });
  assert.match(dockerfile, /^FROM e-harness-codex$/m);
  assert.ok(dockerfile.trimStart().startsWith('FROM e-harness-codex'));
});

test('renderDerivedDockerfile: copies the rendered config into the relocated config dir', () => {
  const dockerfile = renderDerivedDockerfile({
    baseImage: 'e-harness-codex',
    provider: providerBlock,
  });
  assert.match(dockerfile, /^ENV CODEX_HOME=\/root\/\.codex$/m);
  assert.match(dockerfile, /^COPY config\.toml \/root\/\.codex\/config\.toml$/m);
});

test('renderDerivedDockerfile: copies each baked skill tree into the harness skills dir', () => {
  const dockerfile = renderDerivedDockerfile({
    baseImage: 'e-harness-claudecode',
    skills: { skillsDir: '/root/.claude/skills', names: ['a', 'b'] },
  });
  assert.match(dockerfile, /^FROM e-harness-claudecode$/m);
  assert.match(dockerfile, /^COPY skills\/a\/ \/root\/\.claude\/skills\/a\/$/m);
  assert.match(dockerfile, /^COPY skills\/b\/ \/root\/\.claude\/skills\/b\/$/m);
});

test('renderDerivedDockerfile: composes both a provider block and a skills block', () => {
  const dockerfile = renderDerivedDockerfile({
    baseImage: 'e-harness-codex',
    provider: providerBlock,
    skills: { skillsDir: '/root/.agents/skills', names: ['a'] },
  });
  assert.match(dockerfile, /^COPY config\.toml /m);
  assert.match(dockerfile, /^COPY skills\/a\/ \/root\/\.agents\/skills\/a\/$/m);
});

test('renderDerivedDockerfile: keeps every COPY target outside /workspace', () => {
  const dockerfile = renderDerivedDockerfile({
    baseImage: 'e-harness-codex',
    provider: providerBlock,
    skills: { skillsDir: '/root/.agents/skills', names: ['a'] },
  });
  for (const line of dockerfile.split('\n')) {
    if (line.startsWith('COPY')) assert.ok(!line.includes('/workspace'));
  }
});

test('derivedImageTag: is derived from the agent name and distinct from a harness tag', () => {
  assert.equal(derivedImageTag('smart-codex'), 'e-agent-smart-codex');
  assert.ok(derivedImageTag('codex').startsWith('e-agent-'));
});

const envProvider: Provider = {
  baseUrl: 'https://gateway.example.com',
  model: 'claude-opus-5',
  protocol: 'anthropic-messages',
  apiKeyEnv: 'MY_GATEWAY_KEY',
};

const fileProvider: Provider = {
  baseUrl: 'https://gateway.example.com/v1',
  model: 'gpt-5-codex',
  protocol: 'openai-responses',
  apiKeyEnv: 'MY_GATEWAY_KEY',
};

test('planProviderDelivery: an env harness delivers all env and bakes nothing', () => {
  const plan = planProviderDelivery(facts(), claudeCodeAdapter, envProvider, {
    model: 'claude-opus-5',
    fromAuto: false,
  });
  assert.equal(plan.bakedConfig, undefined);
  assert.equal(plan.runtimeModel, undefined);
  assert.deepEqual(
    plan.runtimeEnv,
    claudeCodeAdapter.renderProviderEnv({ ...envProvider, model: 'claude-opus-5' }),
  );
});

test('planProviderDelivery: an env harness carries the auto-resolved model in env', () => {
  const plan = planProviderDelivery(
    facts(),
    claudeCodeAdapter,
    { ...envProvider, model: 'auto' },
    { model: 'claude-opus-5', fromAuto: true },
  );
  assert.equal(plan.runtimeModel, undefined);
  assert.ok(
    plan.runtimeEnv.some(
      (e) => e.name === 'ANTHROPIC_MODEL' && 'value' in e && e.value === 'claude-opus-5',
    ),
  );
});

test('planProviderDelivery: a file harness bakes a concrete model into its config, no runtime model', () => {
  const plan = planProviderDelivery(
    facts(),
    codexAdapter,
    { ...fileProvider, model: 'gpt-5-codex' },
    { model: 'gpt-5-codex', fromAuto: false },
  );
  assert.ok(plan.bakedConfig);
  assert.equal(plan.bakedConfig.file.fileName, 'config.toml');
  assert.equal(plan.bakedConfig.configDir, '/root/.codex');
  assert.equal(plan.bakedConfig.configDirEnv, 'CODEX_HOME');
  assert.match(plan.bakedConfig.file.content, /^model = "gpt-5-codex"$/m);
  assert.equal(plan.runtimeModel, undefined);
  // Only the API key is delivered at runtime for a file harness.
  assert.deepEqual(plan.runtimeEnv, codexAdapter.renderRuntimeEnv(fileProvider));
});

test('planProviderDelivery: a file harness keeps an auto model out of the config, delivers it on the command', () => {
  const plan = planProviderDelivery(
    facts(),
    codexAdapter,
    { ...fileProvider, model: 'auto' },
    { model: 'gpt-5-codex', fromAuto: true },
  );
  assert.ok(plan.bakedConfig);
  assert.doesNotMatch(plan.bakedConfig.file.content, /^model = /m);
  assert.equal(plan.runtimeModel, 'gpt-5-codex');
});

const piProvider: Provider = {
  baseUrl: 'https://gateway.example.com/v1',
  model: 'auto',
  protocol: 'anthropic-messages',
  apiKeyEnv: 'MY_GATEWAY_KEY',
};

test('planProviderDelivery: pi bakes the resolved auto model into models.json AND passes it on the command', () => {
  const plan = planProviderDelivery(facts(), piAdapter, piProvider, {
    model: 'claude-opus-5',
    fromAuto: true,
  });
  assert.ok(plan.bakedConfig);
  assert.equal(plan.bakedConfig.file.fileName, 'models.json');
  assert.equal(plan.bakedConfig.configDir, '/root/.pi/agent');
  assert.equal(plan.bakedConfig.configDirEnv, 'PI_CODING_AGENT_DIR');
  // pi requires the model declared in the file to select it, so even an
  // auto-resolved model is baked (unlike Codex's command-only `-m`).
  const cfg = JSON.parse(plan.bakedConfig.file.content);
  assert.deepEqual(cfg.providers.e.models, [{ id: 'claude-opus-5' }]);
  // ...and it is still passed on the command line for provider/model selection.
  assert.equal(plan.runtimeModel, 'claude-opus-5');
  assert.deepEqual(plan.runtimeEnv, piAdapter.renderRuntimeEnv(piProvider));
});

test('planProviderDelivery: pi bakes a concrete model too and passes it for selection', () => {
  const plan = planProviderDelivery(
    facts(),
    piAdapter,
    { ...piProvider, model: 'claude-opus-5' },
    { model: 'claude-opus-5', fromAuto: false },
  );
  const cfg = JSON.parse(plan.bakedConfig!.file.content);
  assert.deepEqual(cfg.providers.e.models, [{ id: 'claude-opus-5' }]);
  assert.equal(plan.runtimeModel, 'claude-opus-5');
});

test('planAgentImage: nothing to bake (no provider, no skills) derives no image', () => {
  assert.equal(
    planAgentImage({ baseImage: 'e-harness-pi', agentName: 'pi' }),
    undefined,
  );
});

test('planAgentImage: provider-only bakes config + Dockerfile, no skills (Codex today)', () => {
  const delivery = planProviderDelivery(facts(), codexAdapter, fileProvider, {
    model: 'gpt-5-codex',
    fromAuto: false,
  });
  const image = planAgentImage({
    baseImage: 'e-harness-codex',
    agentName: 'smart-codex',
    bakedConfig: delivery.bakedConfig,
  });
  assert.ok(image);
  assert.equal(image.imageTag, 'e-agent-smart-codex');
  assert.deepEqual(image.files.map((f) => f.fileName), ['config.toml', 'Dockerfile']);
  assert.deepEqual(image.skillNames, []);
  const dockerfile = image.files.find((f) => f.fileName === 'Dockerfile')!;
  assert.match(dockerfile.content, /^COPY config\.toml /m);
  assert.doesNotMatch(dockerfile.content, /COPY skills/);
});

test('planAgentImage: skills-only bakes a Dockerfile that copies the skill trees (any harness)', () => {
  const image = planAgentImage({
    baseImage: 'e-harness-claudecode',
    agentName: 'skilled-claude',
    skills: { skillsDir: '/root/.claude/skills', names: ['helper'] },
  });
  assert.ok(image);
  assert.deepEqual(image.files.map((f) => f.fileName), ['Dockerfile']);
  assert.deepEqual(image.skillNames, ['helper']);
  const dockerfile = image.files[0];
  assert.match(dockerfile.content, /^FROM e-harness-claudecode$/m);
  assert.match(dockerfile.content, /^COPY skills\/helper\/ \/root\/\.claude\/skills\/helper\/$/m);
});

test('planAgentImage: provider + skills compose into one derived image', () => {
  const delivery = planProviderDelivery(facts(), codexAdapter, fileProvider, {
    model: 'gpt-5-codex',
    fromAuto: false,
  });
  const image = planAgentImage({
    baseImage: 'e-harness-codex',
    agentName: 'smart-codex',
    bakedConfig: delivery.bakedConfig,
    skills: { skillsDir: '/root/.agents/skills', names: ['helper'] },
  });
  assert.ok(image);
  assert.deepEqual(image.files.map((f) => f.fileName), ['config.toml', 'Dockerfile']);
  assert.deepEqual(image.skillNames, ['helper']);
  const dockerfile = image.files.find((f) => f.fileName === 'Dockerfile')!;
  assert.match(dockerfile.content, /^COPY config\.toml /m);
  assert.match(dockerfile.content, /^COPY skills\/helper\/ /m);
});
