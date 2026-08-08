import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orderEnvFiles,
  decideImageAction,
  resolveSpawnTarget,
  validateSpawn,
  planSpawn,
  type SpawnFacts,
} from './spawnPlan';
import { HARNESSES } from './harness/index';
import type { McpServer } from './mcp/index';
import type { ResolvedModel } from './model/resolve';

function facts(overrides: Partial<SpawnFacts>): SpawnFacts {
  return {
    root: '/root',
    agent: { name: 'demo', harness: 'claudeCode', tier: 'default' },
    harness: HARNESSES.claudeCode,
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

const containerMcp: McpServer = {
  name: 'everything',
  transport: 'container',
  port: 3001,
  requiredEnv: [],
};
const secretMcp: McpServer = {
  name: 'secret',
  transport: 'container',
  port: 3002,
  requiredEnv: ['SECRET_TOKEN'],
};
const auto: ResolvedModel = { model: 'gpt-5-codex', fromAuto: true };
const concrete: ResolvedModel = { model: 'claude-opus-5', fromAuto: false };

test('orderEnvFiles: no files when neither is present', () => {
  assert.deepEqual(orderEnvFiles(undefined, undefined), []);
});

test('orderEnvFiles: base only', () => {
  assert.deepEqual(orderEnvFiles('/root/.e/.env', undefined), ['/root/.e/.env']);
});

test('orderEnvFiles: user file only', () => {
  assert.deepEqual(orderEnvFiles(undefined, '/tmp/my.env'), ['/tmp/my.env']);
});

test('orderEnvFiles: base first, user file second (user overrides base)', () => {
  // Order is the contract: later --env-file entries override earlier ones for
  // the same key, so the user's file must come after the base .e/.env.
  assert.deepEqual(orderEnvFiles('/root/.e/.env', '/tmp/my.env'), [
    '/root/.e/.env',
    '/tmp/my.env',
  ]);
});

// decideImageAction truth table over (rebuild, imageExists, initialized).
// need-build = rebuild || !imageExists; then initialized ? 'build' : 'not-initialized'.
const cases: Array<{
  rebuild: boolean;
  imageExists: boolean;
  initialized: boolean;
  expected: 'skip' | 'build' | 'not-initialized';
}> = [
  { rebuild: false, imageExists: false, initialized: false, expected: 'not-initialized' },
  { rebuild: false, imageExists: false, initialized: true, expected: 'build' },
  { rebuild: false, imageExists: true, initialized: false, expected: 'skip' },
  { rebuild: false, imageExists: true, initialized: true, expected: 'skip' },
  { rebuild: true, imageExists: false, initialized: false, expected: 'not-initialized' },
  { rebuild: true, imageExists: false, initialized: true, expected: 'build' },
  { rebuild: true, imageExists: true, initialized: false, expected: 'not-initialized' },
  { rebuild: true, imageExists: true, initialized: true, expected: 'build' },
];

for (const { rebuild, imageExists, initialized, expected } of cases) {
  test(`decideImageAction: rebuild=${rebuild} imageExists=${imageExists} initialized=${initialized} -> ${expected}`, () => {
    assert.equal(
      decideImageAction({ rebuild, imageExists, initialized }),
      expected,
    );
  });
}

// resolveSpawnTarget is pure: it takes the positional args, the favorite
// harness, and a `isKnownTarget` predicate, and decides target-vs-prompt.
const known = (names: string[]) => (name: string) => names.includes(name);

test('resolveSpawnTarget: no target runs the favorite with an empty prompt', () => {
  assert.deepEqual(
    resolveSpawnTarget({
      target: undefined,
      prompt: [],
      defaultHarness: 'pi',
      isKnownTarget: known(['pi', 'codex']),
    }),
    { agentTarget: 'pi', prompt: [] },
  );
});

test('resolveSpawnTarget: a known target keeps existing behavior (target + prompt)', () => {
  assert.deepEqual(
    resolveSpawnTarget({
      target: 'codex',
      prompt: ['fix', 'the', 'bug'],
      defaultHarness: 'pi',
      isKnownTarget: known(['pi', 'codex']),
    }),
    { agentTarget: 'codex', prompt: ['fix', 'the', 'bug'] },
  );
});

test('resolveSpawnTarget: an unknown first arg is part of the prompt, run on the favorite', () => {
  // `e spawn "fix the bug"` — the quoted prompt lands in `target`.
  assert.deepEqual(
    resolveSpawnTarget({
      target: 'fix the bug',
      prompt: [],
      defaultHarness: 'pi',
      isKnownTarget: known(['pi', 'codex']),
    }),
    { agentTarget: 'pi', prompt: ['fix the bug'] },
  );
});

test('resolveSpawnTarget: an unquoted unknown prompt keeps all its words in order', () => {
  // `e spawn fix the bug` — commander splits into target + prompt words.
  assert.deepEqual(
    resolveSpawnTarget({
      target: 'fix',
      prompt: ['the', 'bug'],
      defaultHarness: 'pi',
      isKnownTarget: known(['pi', 'codex']),
    }),
    { agentTarget: 'pi', prompt: ['fix', 'the', 'bug'] },
  );
});

// --- validateSpawn (pure, fail-fast) ---

test('validateSpawn: rejects a provider protocol the harness does not speak', () => {
  const f = facts({
    agent: {
      name: 'x',
      harness: 'claudeCode',
      tier: 'default',
      provider: {
        baseUrl: 'https://h',
        model: 'auto',
        protocol: 'openai-responses',
        apiKeyEnv: 'K',
      },
    },
  });
  assert.throws(() => validateSpawn(f), /does not speak protocol/);
});

test('validateSpawn: rejects a provider on a harness with no config adapter', () => {
  const f = facts({
    harness: HARNESSES.opencode,
    agent: {
      name: 'x',
      harness: 'opencode',
      tier: 'default',
      provider: {
        baseUrl: 'https://h',
        model: 'auto',
        protocol: 'openai-chat',
        apiKeyEnv: 'K',
      },
    },
  });
  assert.throws(() => validateSpawn(f), /no config adapter/);
});

test('validateSpawn: rejects --mcp against a harness with no MCP client (pi)', () => {
  const f = facts({
    harness: HARNESSES.pi,
    agent: { name: 'pi', harness: 'pi', tier: 'default' },
    mcpServers: [containerMcp],
  });
  assert.throws(() => validateSpawn(f), /has no MCP client/);
});

test('validateSpawn: passes for a plain default agent', () => {
  assert.doesNotThrow(() => validateSpawn(facts({})));
});

// --- planSpawn (pure composition) ---

test('planSpawn: env harness delivers the provider as runtime env, nothing baked', () => {
  const f = facts({
    agent: {
      name: 'x',
      harness: 'claudeCode',
      tier: 'default',
      provider: {
        baseUrl: 'https://h',
        model: 'auto',
        protocol: 'anthropic-messages',
        apiKeyEnv: 'MY_KEY',
      },
    },
    storeEnv: { MY_KEY: 'sk-abc' },
  });
  const plan = planSpawn(f, concrete);
  assert.ok(plan.delivery);
  assert.match(plan.providerEnvContent ?? '', /ANTHROPIC_MODEL=claude-opus-5/);
  assert.match(plan.providerEnvContent ?? '', /ANTHROPIC_AUTH_TOKEN=sk-abc/);
  // Env harness bakes nothing from the provider, so no derived image.
  assert.equal(plan.agentImagePlan, undefined);
  assert.equal(plan.runtimeModel, undefined);
});

test('planSpawn: file harness bakes a derived image and passes an auto model on the command', () => {
  const f = facts({
    harness: HARNESSES.codex,
    agent: {
      name: 'smart-codex',
      harness: 'codex',
      tier: 'smart',
      provider: {
        baseUrl: 'https://h',
        model: 'auto',
        protocol: 'openai-responses',
        apiKeyEnv: 'OPENAI_API_KEY',
      },
    },
    storeEnv: { OPENAI_API_KEY: 'sk-x' },
  });
  const plan = planSpawn(f, auto);
  assert.ok(plan.delivery?.bakedConfig);
  assert.equal(plan.agentImagePlan?.imageTag, 'e-agent-smart-codex');
  assert.equal(plan.runtimeModel, 'gpt-5-codex');
});

test('planSpawn: a flag-MCP harness (claude) wires --mcp-config, no overlay', () => {
  const plan = planSpawn(facts({ mcpServers: [containerMcp] }));
  assert.equal(plan.sidecars.length, 1);
  assert.equal(plan.sidecars[0].image, 'e-mcp-everything');
  assert.ok(plan.mcpArgs.includes('--mcp-config'));
  assert.equal(plan.configOverlay, undefined);
});

test('planSpawn: a file-MCP harness (codex) renders a config overlay, no mcpArgs', () => {
  const f = facts({
    harness: HARNESSES.codex,
    agent: { name: 'codex', harness: 'codex', tier: 'default' },
    mcpServers: [containerMcp],
  });
  const plan = planSpawn(f);
  assert.deepEqual(plan.mcpArgs, []);
  assert.ok(plan.configOverlay);
  assert.equal(plan.configOverlay?.mountTo, '/root/.codex/config.toml');
});

test('planSpawn: a sidecar credential is rendered from storeEnv', () => {
  const plan = planSpawn(
    facts({ mcpServers: [secretMcp], storeEnv: { SECRET_TOKEN: 'tok' } }),
  );
  assert.equal(plan.sidecarCredentials.secret, 'SECRET_TOKEN=tok\n');
});

test('planSpawn: a missing sidecar credential is a hard error', () => {
  assert.throws(
    () => planSpawn(facts({ mcpServers: [secretMcp], storeEnv: {} })),
    /MCP server "secret"[\s\S]*SECRET_TOKEN[\s\S]*not set in \.e\/\.env/,
  );
});

test('planSpawn: baked skills go to the derived image; per-run skills become mounts', () => {
  const f = facts({ bakedSkills: ['baked-skill'], perRunSkills: ['run-skill'] });
  const plan = planSpawn(f);
  assert.deepEqual(plan.agentImagePlan?.skillNames, ['baked-skill']);
  assert.equal(plan.skillMounts.length, 1);
  assert.equal(plan.skillMounts[0].container, '/root/.claude/skills/run-skill');
  assert.equal(plan.skillMounts[0].ro, true);
});
