import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderDerivedDockerfile,
  derivedImageTag,
  planProviderDelivery,
  planAgentImage,
} from './deriveImage.js';
import {
  claudeCodeAdapter,
  codexAdapter,
  piAdapter,
  type Provider,
} from './adapter.js';

const providerBlock = {
  configFileName: 'config.toml',
  configDir: '/home/node/.codex',
  configDirEnv: 'CODEX_HOME',
};

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
  assert.match(dockerfile, /^ENV CODEX_HOME=\/home\/node\/\.codex$/m);
  assert.match(
    dockerfile,
    /^COPY config\.toml \/home\/node\/\.codex\/config\.toml$/m
  );
});

test('renderDerivedDockerfile: builds COPY layers as root, then hands the trees to the non-root user', () => {
  const dockerfile = renderDerivedDockerfile({
    baseImage: 'e-harness-codex',
    provider: providerBlock,
    skills: { skillsDir: '/home/node/.agents/skills', names: ['a'] },
  });
  // The base harness image ends with `USER node`; the derived COPY layers must
  // escalate (the config dir may not exist yet) and then return ownership.
  const userRootIdx = dockerfile.indexOf('USER root');
  const copyIdx = dockerfile.indexOf('COPY ');
  assert.ok(userRootIdx !== -1 && copyIdx > userRootIdx);
  assert.match(
    dockerfile,
    /^RUN chown -R node:node \/home\/node\/\.codex \/home\/node\/\.agents\/skills$/m
  );
  assert.match(dockerfile, /^USER node$/m);
  // USER node is the final instruction: the container runs non-root.
  assert.ok(dockerfile.trimEnd().endsWith('USER node'));
});

test('renderDerivedDockerfile: a root runtime-user harness needs no escalation', () => {
  const dockerfile = renderDerivedDockerfile({
    baseImage: 'e-harness-root',
    provider: providerBlock,
    runtimeUser: 'root',
  });
  assert.doesNotMatch(dockerfile, /USER/);
  assert.doesNotMatch(dockerfile, /chown/);
  assert.match(
    dockerfile,
    /^COPY config\.toml \/home\/node\/\.codex\/config\.toml$/m
  );
});

test('renderDerivedDockerfile: copies each baked skill tree into the harness skills dir', () => {
  const dockerfile = renderDerivedDockerfile({
    baseImage: 'e-harness-claudecode',
    skills: { skillsDir: '/home/node/.claude/skills', names: ['a', 'b'] },
  });
  assert.match(dockerfile, /^FROM e-harness-claudecode$/m);
  assert.match(dockerfile, /^COPY skills\/a\/ \/home\/node\/\.claude\/skills\/a\/$/m);
  assert.match(dockerfile, /^COPY skills\/b\/ \/home\/node\/\.claude\/skills\/b\/$/m);
});

test('renderDerivedDockerfile: composes both a provider block and a skills block', () => {
  const dockerfile = renderDerivedDockerfile({
    baseImage: 'e-harness-codex',
    provider: providerBlock,
    skills: { skillsDir: '/home/node/.agents/skills', names: ['a'] },
  });
  assert.match(dockerfile, /^COPY config\.toml /m);
  assert.match(dockerfile, /^COPY skills\/a\/ \/home\/node\/\.agents\/skills\/a\/$/m);
});

test('renderDerivedDockerfile: keeps every COPY target outside /workspace', () => {
  const dockerfile = renderDerivedDockerfile({
    baseImage: 'e-harness-codex',
    provider: providerBlock,
    skills: { skillsDir: '/home/node/.agents/skills', names: ['a'] },
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
  const plan = planProviderDelivery({}, claudeCodeAdapter, envProvider);
  assert.equal(plan.bakedConfig, undefined);
  assert.equal(plan.runtimeModel, undefined);
  assert.deepEqual(
    plan.runtimeEnv,
    claudeCodeAdapter.renderProviderEnv({
      ...envProvider,
      model: 'claude-opus-5',
    })
  );
});

test('planProviderDelivery: an env harness carries auto model in env', () => {
  const plan = planProviderDelivery(
    {},
    claudeCodeAdapter,
    { ...envProvider, model: 'auto/coding' },
  );
  assert.equal(plan.runtimeModel, undefined);
  assert.ok(
    plan.runtimeEnv.some(
      e =>
        e.name === 'ANTHROPIC_MODEL' &&
        'value' in e &&
        e.value === 'auto'
    )
  );
});

test('planProviderDelivery: a file harness bakes a concrete model into its config, no runtime model', () => {
  const plan = planProviderDelivery(
    {},
    codexAdapter,
    { ...fileProvider, model: 'gpt-5-codex' },
  );
  assert.ok(plan.bakedConfig);
  assert.equal(plan.bakedConfig.file.fileName, 'config.toml');
  assert.equal(plan.bakedConfig.configDir, '/home/node/.codex');
  assert.equal(plan.bakedConfig.configDirEnv, 'CODEX_HOME');
  assert.match(plan.bakedConfig.file.content, /^model = "gpt-5-codex"$/m);
  assert.equal(plan.runtimeModel, undefined);
  // Only the API key is delivered at runtime for a file harness.
  assert.deepEqual(
    plan.runtimeEnv,
    codexAdapter.renderRuntimeEnv(fileProvider)
  );
});

test('planProviderDelivery: a file harness keeps an auto model out of the config, delivers it on the command', () => {
  const plan = planProviderDelivery(
    {},
    codexAdapter,
    { ...fileProvider, model: 'auto/coding' },
  );
  assert.ok(plan.bakedConfig);
  assert.doesNotMatch(plan.bakedConfig.file.content, /^model = /m);
  assert.equal(plan.runtimeModel, 'auto');
});

const piProvider: Provider = {
  baseUrl: 'https://gateway.example.com/v1',
  model: 'auto/coding',
  protocol: 'anthropic-messages',
  apiKeyEnv: 'MY_GATEWAY_KEY',
};

test('planProviderDelivery: pi bakes auto model into models.json and passes it on the command', () => {
  const plan = planProviderDelivery({}, piAdapter, piProvider);
  assert.ok(plan.bakedConfig);
  assert.equal(plan.bakedConfig.file.fileName, 'models.json');
  assert.equal(plan.bakedConfig.configDir, '/home/node/.pi/agent');
  assert.equal(plan.bakedConfig.configDirEnv, 'PI_CODING_AGENT_DIR');
  // pi requires the model declared in the file to select it, so auto is baked.
  const cfg = JSON.parse(plan.bakedConfig.file.content);
  assert.deepEqual(cfg.providers.e.models, [{ id: 'auto' }]);
  // It is still passed on the command line for provider/model selection.
  assert.equal(plan.runtimeModel, 'auto');
  assert.deepEqual(plan.runtimeEnv, piAdapter.renderRuntimeEnv(piProvider));
});

test('planProviderDelivery: pi bakes a concrete model too and passes it for selection', () => {
  const plan = planProviderDelivery(
    {},
    piAdapter,
    { ...piProvider, model: 'claude-opus-5' }
  );
  const cfg = JSON.parse(plan.bakedConfig!.file.content);
  assert.deepEqual(cfg.providers.e.models, [{ id: 'claude-opus-5' }]);
  assert.equal(plan.runtimeModel, 'claude-opus-5');
});

test('planAgentImage: nothing to bake (no provider, no skills) derives no image', () => {
  assert.equal(
    planAgentImage({ baseImage: 'e-harness-pi', agentName: 'pi' }),
    undefined
  );
});

test('planAgentImage: provider-only bakes config + Dockerfile, no skills (Codex today)', () => {
  const delivery = planProviderDelivery({}, codexAdapter, fileProvider);
  const image = planAgentImage({
    baseImage: 'e-harness-codex',
    agentName: 'smart-codex',
    bakedConfig: delivery.bakedConfig,
  });
  assert.ok(image);
  assert.equal(image.imageTag, 'e-agent-smart-codex');
  assert.deepEqual(
    image.files.map(f => f.fileName),
    ['config.toml', 'Dockerfile']
  );
  assert.deepEqual(image.skillNames, []);
  const dockerfile = image.files.find(f => f.fileName === 'Dockerfile')!;
  assert.match(dockerfile.content, /^COPY config\.toml /m);
  assert.doesNotMatch(dockerfile.content, /COPY skills/);
});

test('planAgentImage: skills-only bakes a Dockerfile that copies the skill trees (any harness)', () => {
  const image = planAgentImage({
    baseImage: 'e-harness-claudecode',
    agentName: 'skilled-claude',
    skills: { skillsDir: '/home/node/.claude/skills', names: ['helper'] },
  });
  assert.ok(image);
  assert.deepEqual(
    image.files.map(f => f.fileName),
    ['Dockerfile']
  );
  assert.deepEqual(image.skillNames, ['helper']);
  const dockerfile = image.files[0];
  assert.match(dockerfile.content, /^FROM e-harness-claudecode$/m);
  assert.match(
    dockerfile.content,
    /^COPY skills\/helper\/ \/home\/node\/\.claude\/skills\/helper\/$/m
  );
});

test('planAgentImage: passes the harness runtime user into the derived render', () => {
  const image = planAgentImage({
    baseImage: 'e-harness-codex',
    agentName: 'smart-codex',
    bakedConfig: planProviderDelivery({}, codexAdapter, fileProvider)
      .bakedConfig,
    runtimeUser: 'root',
  });
  assert.ok(image);
  const dockerfile = image.files.find(f => f.fileName === 'Dockerfile')!;
  assert.doesNotMatch(dockerfile.content, /USER/);
  assert.doesNotMatch(dockerfile.content, /chown/);
});

test('planAgentImage: provider + skills compose into one derived image', () => {
  const delivery = planProviderDelivery({}, codexAdapter, fileProvider);
  const image = planAgentImage({
    baseImage: 'e-harness-codex',
    agentName: 'smart-codex',
    bakedConfig: delivery.bakedConfig,
    skills: { skillsDir: '/home/node/.agents/skills', names: ['helper'] },
  });
  assert.ok(image);
  assert.deepEqual(
    image.files.map(f => f.fileName),
    ['config.toml', 'Dockerfile']
  );
  assert.deepEqual(image.skillNames, ['helper']);
  const dockerfile = image.files.find(f => f.fileName === 'Dockerfile')!;
  assert.match(dockerfile.content, /^COPY config\.toml /m);
  assert.match(dockerfile.content, /^COPY skills\/helper\/ /m);
  // Default runtime user: the derived image ends non-root like its base.
  assert.ok(dockerfile.content.trimEnd().endsWith('USER node'));
});
