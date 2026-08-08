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
  const plan = planProviderDelivery(claudeCodeAdapter, envProvider, {
    agentName: 'smart-claude',
    baseImage: 'e-harness-claudecode',
  });
  assert.equal(plan.derived, undefined);
  // The whole provider (endpoint, model, key) is delivered at runtime.
  assert.deepEqual(plan.runtimeEnv, claudeCodeAdapter.renderProviderEnv(envProvider));
});

test('planProviderDelivery: a file harness plans a derived image with config + Dockerfile', () => {
  const plan = planProviderDelivery(codexAdapter, fileProvider, {
    agentName: 'smart-codex',
    baseImage: 'e-harness-codex',
  });
  assert.ok(plan.derived);
  assert.equal(plan.derived.imageTag, 'e-agent-smart-codex');

  const names = plan.derived.files.map((f) => f.fileName);
  assert.deepEqual(names, ['config.toml', 'Dockerfile']);

  // The rendered Dockerfile is FROM the base and copies the rendered config.
  const dockerfile = plan.derived.files.find((f) => f.fileName === 'Dockerfile');
  assert.ok(dockerfile);
  assert.match(dockerfile.content, /^FROM e-harness-codex$/m);
  assert.match(dockerfile.content, /^COPY config\.toml /m);

  // Only the API key is delivered at runtime; the endpoint/model are baked.
  assert.deepEqual(plan.runtimeEnv, codexAdapter.renderRuntimeEnv(fileProvider));
});

test('planProviderDelivery: a file harness rejects an `auto` model before any build', () => {
  assert.throws(
    () =>
      planProviderDelivery(
        codexAdapter,
        { ...fileProvider, model: 'auto' },
        { agentName: 'smart-codex', baseImage: 'e-harness-codex' },
      ),
    /auto/,
  );
});
