import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderDerivedDockerfile,
  derivedImageTag,
  planProviderDelivery,
} from './deriveImage';
import { claudeCodeAdapter, codexAdapter, type Provider } from './adapter';

test('renderDerivedDockerfile: builds FROM the harness base image (layer-2 reuse)', () => {
  const dockerfile = renderDerivedDockerfile({
    baseImage: 'e-harness-codex',
    configFileName: 'config.toml',
    configDir: '/root/.codex',
    configDirEnv: 'CODEX_HOME',
  });
  // The first instruction must be FROM the shared harness base, so the base's
  // layers are reused/cached rather than rebuilt.
  assert.match(dockerfile, /^FROM e-harness-codex$/m);
  assert.ok(dockerfile.trimStart().startsWith('FROM e-harness-codex'));
});

test('renderDerivedDockerfile: copies the rendered config into the relocated config dir', () => {
  const dockerfile = renderDerivedDockerfile({
    baseImage: 'e-harness-codex',
    configFileName: 'config.toml',
    configDir: '/root/.codex',
    configDirEnv: 'CODEX_HOME',
  });
  assert.match(dockerfile, /^ENV CODEX_HOME=\/root\/\.codex$/m);
  assert.match(dockerfile, /^COPY config\.toml \/root\/\.codex\/config\.toml$/m);
});

test('renderDerivedDockerfile: keeps baked config outside /workspace', () => {
  const dockerfile = renderDerivedDockerfile({
    baseImage: 'e-harness-codex',
    configFileName: 'config.toml',
    configDir: '/root/.codex',
    configDirEnv: 'CODEX_HOME',
  });
  // No COPY target may land under /workspace, or it would pollute the run branch.
  for (const line of dockerfile.split('\n')) {
    if (line.startsWith('COPY')) assert.ok(!line.includes('/workspace'));
  }
});

test('derivedImageTag: is derived from the agent name and distinct from a harness tag', () => {
  assert.equal(derivedImageTag('smart-codex'), 'e-agent-smart-codex');
  // Distinct namespace from harness images (`e-harness-*`) so the two never collide.
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

test('planProviderDelivery: an env harness delivers all env and derives no image', () => {
  const plan = planProviderDelivery(
    claudeCodeAdapter,
    envProvider,
    { model: 'claude-opus-5', fromAuto: false },
    { agentName: 'smart-claude', baseImage: 'e-harness-claudecode' },
  );
  assert.equal(plan.derived, undefined);
  assert.equal(plan.runtimeModel, undefined);
  // The whole provider (endpoint, resolved model, key) is delivered at runtime.
  assert.deepEqual(
    plan.runtimeEnv,
    claudeCodeAdapter.renderProviderEnv({ ...envProvider, model: 'claude-opus-5' }),
  );
});

test('planProviderDelivery: an env harness carries the auto-resolved model in env', () => {
  const plan = planProviderDelivery(
    claudeCodeAdapter,
    { ...envProvider, model: 'auto' },
    { model: 'claude-opus-5', fromAuto: true },
    { agentName: 'smart-claude', baseImage: 'e-harness-claudecode' },
  );
  // Even from auto, the model rides ANTHROPIC_MODEL at runtime, not the command.
  assert.equal(plan.runtimeModel, undefined);
  assert.ok(
    plan.runtimeEnv.some(
      (e) => e.name === 'ANTHROPIC_MODEL' && 'value' in e && e.value === 'claude-opus-5',
    ),
  );
});

test('planProviderDelivery: a file harness bakes a concrete model, no runtime model', () => {
  const plan = planProviderDelivery(
    codexAdapter,
    { ...fileProvider, model: 'gpt-5-codex' },
    { model: 'gpt-5-codex', fromAuto: false },
    { agentName: 'smart-codex', baseImage: 'e-harness-codex' },
  );
  assert.ok(plan.derived);
  assert.equal(plan.derived.imageTag, 'e-agent-smart-codex');
  assert.equal(plan.runtimeModel, undefined);

  const names = plan.derived.files.map((f) => f.fileName);
  assert.deepEqual(names, ['config.toml', 'Dockerfile']);

  const config = plan.derived.files.find((f) => f.fileName === 'config.toml');
  assert.ok(config);
  assert.match(config.content, /^model = "gpt-5-codex"$/m);

  const dockerfile = plan.derived.files.find((f) => f.fileName === 'Dockerfile');
  assert.ok(dockerfile);
  assert.match(dockerfile.content, /^FROM e-harness-codex$/m);
  assert.match(dockerfile.content, /^COPY config\.toml /m);

  // Only the API key is delivered at runtime for a file harness.
  assert.deepEqual(plan.runtimeEnv, codexAdapter.renderRuntimeEnv(fileProvider));
});

test('planProviderDelivery: a file harness keeps an auto model out of the config, delivers it on the command', () => {
  const plan = planProviderDelivery(
    codexAdapter,
    { ...fileProvider, model: 'auto' },
    { model: 'gpt-5-codex', fromAuto: true },
    { agentName: 'smart-codex', baseImage: 'e-harness-codex' },
  );
  assert.ok(plan.derived);
  const config = plan.derived.files.find((f) => f.fileName === 'config.toml');
  assert.ok(config);
  // The resolved model is NOT baked...
  assert.doesNotMatch(config.content, /^model = /m);
  // ...it is delivered on the run command instead.
  assert.equal(plan.runtimeModel, 'gpt-5-codex');
});
