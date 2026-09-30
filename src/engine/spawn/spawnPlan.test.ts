import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orderEnvFiles,
  decideImageAction,
  resolveSpawnTarget,
  isInteractiveRun,
  validateSpawn,
  planSpawn,
  type SpawnFacts,
} from './spawnPlan.js';
import { opencodeAdapter } from '../../core/harness/adapter.js';
import { HARNESSES } from '../../core/harness/index.js';
import { GLOBAL_BASE_URL_ENV } from '../../core/harness/renderEnvTemplate.js';
import type { McpServer } from '../../core/mcp/index.js';
import { defaultBrokerPlan } from '../sidecarPlan.js';

function facts(overrides: Partial<SpawnFacts>): SpawnFacts {
  return {
    root: '/root',
    agent: { name: 'demo', harness: 'claudeCode' },
    harness: HARNESSES.claudeCode,
    storeEnv: {},
    mcpServers: [],
    perRunSkills: [],
    bakedSkills: [],
    prompt: 'do it',
    localStackPresent: false,
    rebuild: false,
    env: [],
    worktreesDir: '/tmp/e-worktrees',
    siblingArtifacts: ['node_modules'],
    maxSiblings: 3,
    localRuntimes: [],
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
const remoteSecretMcp: McpServer = {
  name: 'hosted',
  transport: 'remote',
  url: 'https://mcp.example.com/mcp',
  requiredEnv: ['REMOTE_TOKEN'],
};

test('orderEnvFiles: no files when neither is present', () => {
  assert.deepEqual(orderEnvFiles(undefined, undefined), []);
});

test('orderEnvFiles: base only', () => {
  assert.deepEqual(orderEnvFiles('/root/.e/.env', undefined), [
    '/root/.e/.env',
  ]);
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
  {
    rebuild: false,
    imageExists: false,
    initialized: false,
    expected: 'not-initialized',
  },
  { rebuild: false, imageExists: false, initialized: true, expected: 'build' },
  { rebuild: false, imageExists: true, initialized: false, expected: 'skip' },
  { rebuild: false, imageExists: true, initialized: true, expected: 'skip' },
  {
    rebuild: true,
    imageExists: false,
    initialized: false,
    expected: 'not-initialized',
  },
  { rebuild: true, imageExists: false, initialized: true, expected: 'build' },
  {
    rebuild: true,
    imageExists: true,
    initialized: false,
    expected: 'not-initialized',
  },
  { rebuild: true, imageExists: true, initialized: true, expected: 'build' },
];

for (const { rebuild, imageExists, initialized, expected } of cases) {
  test(`decideImageAction: rebuild=${rebuild} imageExists=${imageExists} initialized=${initialized} -> ${expected}`, () => {
    assert.equal(
      decideImageAction({ rebuild, imageExists, initialized, pinned: true }),
      expected
    );
  });
}

test('decideImageAction: an existing image off the pin is rebuilt, never run - or, uninitialized, refused', () => {
  assert.equal(
    decideImageAction({
      rebuild: false,
      imageExists: true,
      initialized: true,
      pinned: false,
    }),
    'build'
  );
  assert.equal(
    decideImageAction({
      rebuild: false,
      imageExists: true,
      initialized: false,
      pinned: false,
    }),
    'not-initialized'
  );
});

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
    { agentTarget: 'pi', prompt: [] }
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
    { agentTarget: 'codex', prompt: ['fix', 'the', 'bug'] }
  );
});

test('resolveSpawnTarget: an unknown first arg is part of the prompt, run on the favorite', () => {
  // `e spawn "fix the bug"` - the quoted prompt lands in `target`.
  assert.deepEqual(
    resolveSpawnTarget({
      target: 'fix the bug',
      prompt: [],
      defaultHarness: 'pi',
      isKnownTarget: known(['pi', 'codex']),
    }),
    { agentTarget: 'pi', prompt: ['fix the bug'] }
  );
});

test('resolveSpawnTarget: an unquoted unknown prompt keeps all its words in order', () => {
  // `e spawn fix the bug` - commander splits into target + prompt words.
  assert.deepEqual(
    resolveSpawnTarget({
      target: 'fix',
      prompt: ['the', 'bug'],
      defaultHarness: 'pi',
      isKnownTarget: known(['pi', 'codex']),
    }),
    { agentTarget: 'pi', prompt: ['fix', 'the', 'bug'] }
  );
});

// isInteractiveRun is pure: the prompt decides the run mode. A prompt means a
// one-shot run (the documented `e spawn <agent> "<prompt>"` contract); no
// prompt means the harness TUI. No flag takes part in the decision.
test('isInteractiveRun: a prompt makes the run one-shot', () => {
  assert.equal(isInteractiveRun({ prompt: 'fix the bug' }), false);
});

test('isInteractiveRun: no prompt opens the TUI', () => {
  assert.equal(isInteractiveRun({ prompt: '' }), true);
});

test('isInteractiveRun: a whitespace-only prompt is no prompt', () => {
  assert.equal(isInteractiveRun({ prompt: '   ' }), true);
});

// --- validateSpawn (pure, fail-fast) ---

test('validateSpawn: rejects a provider protocol the harness does not speak', () => {
  const f = facts({
    agent: {
      name: 'x',
      harness: 'claudeCode',
      provider: {
        baseUrl: 'https://h',
        model: 'auto/coding',
        protocol: 'openai-responses',
        apiKeyEnv: 'K',
      },
    },
  });
  assert.throws(() => validateSpawn(f), /does not speak protocol/);
});

test('validateSpawn: rejects a provider on a harness with no config adapter', () => {
  const f = facts({
    harness: { ...HARNESSES.opencode, adapter: undefined },
    agent: {
      name: 'x',
      harness: 'opencode',
      provider: {
        baseUrl: 'https://h',
        model: 'auto/coding',
        protocol: 'openai-chat',
        apiKeyEnv: 'K',
      },
    },
  });
  assert.throws(() => validateSpawn(f), /no config adapter/);
});

test('validateSpawn: accepts a provider on opencode (its file adapter delivers it)', () => {
  const f = facts({
    harness: HARNESSES.opencode,
    agent: {
      name: 'opencode',
      harness: 'opencode',
      provider: {
        baseUrl: 'https://h',
        model: 'auto/coding',
        protocol: 'openai-chat',
        apiKeyEnv: 'K',
      },
    },
  });
  assert.doesNotThrow(() => validateSpawn(f));
});

test('validateSpawn: rejects --mcp against a harness with no MCP wiring', () => {
  const noMcp = {
    ...HARNESSES.opencode,
    adapter: { ...opencodeAdapter, planConfigOverlay: undefined },
  };
  const f = facts({
    harness: noMcp,
    agent: { name: 'opencode', harness: 'opencode' },
    mcpServers: [containerMcp],
  });
  assert.throws(() => validateSpawn(f), /has no MCP client/);
});

test('validateSpawn: an interactive run without a terminal is refused (nothing to run, nothing to attach)', () => {
  assert.throws(
    () => validateSpawn(facts({ prompt: '', stdinIsTty: false })),
    /No prompt and no terminal/
  );
  assert.throws(
    () => validateSpawn(facts({ prompt: '   ', stdinIsTty: false })),
    /No prompt and no terminal/
  );
  // `stdinIsTty` unknown counts as absent: a caller that cannot say has none.
  assert.throws(
    () => validateSpawn(facts({ prompt: '' })),
    /No prompt and no terminal/
  );
});

test('validateSpawn: the TUI opens from a terminal, and for the headless browser child (ADR-0014)', () => {
  assert.doesNotThrow(() =>
    validateSpawn(facts({ prompt: '', stdinIsTty: true }))
  );
  assert.doesNotThrow(() =>
    validateSpawn(facts({ prompt: '', stdinIsTty: false, headlessTty: true }))
  );
});

test('validateSpawn: a prompt needs no terminal (scripts, siblings, A2A tasks)', () => {
  assert.doesNotThrow(() =>
    validateSpawn(facts({ prompt: 'go', stdinIsTty: false }))
  );
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
      provider: {
        baseUrl: 'https://h',
        model: 'auto/coding',
        protocol: 'anthropic-messages',
        apiKeyEnv: 'MY_KEY',
      },
    },
    storeEnv: { MY_KEY: 'sk-abc' },
  });
  const plan = planSpawn(f);
  assert.ok(plan.delivery);
  assert.match(plan.providerEnvContent ?? '', /ANTHROPIC_MODEL=auto\/coding/);
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
      provider: {
        baseUrl: 'https://h',
        model: 'auto/coding',
        protocol: 'openai-responses',
        apiKeyEnv: 'OPENAI_API_KEY',
      },
    },
    storeEnv: { OPENAI_API_KEY: 'sk-x' },
  });
  const plan = planSpawn(f);
  assert.ok(plan.delivery?.bakedConfig);
  assert.equal(plan.agentImagePlan?.imageTag, 'e-agent-smart-codex');
  assert.equal(plan.runtimeModel, 'auto/coding');
});

test('planSpawn: no file harness bakes or mounts the key value, only its name', () => {
  // The per-run OmniRoute key (ADR-0016 section 13) must reach no file and no
  // image layer: every rendered file references it by name.
  const secret = 'sk-run-9f8e7d6c';
  const provider = {
    baseUrl: 'https://gw.example.com/v1',
    model: 'm',
    apiKeyEnv: 'GW_KEY',
  };
  const remoteMcp = {
    name: 'hosted',
    transport: 'remote' as const,
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
    requiredEnv: ['MCP_TOKEN'],
  };
  const cases = [
    { harness: HARNESSES.pi, protocol: 'anthropic-messages' as const },
    { harness: HARNESSES.codex, protocol: 'openai-responses' as const },
    { harness: HARNESSES.opencode, protocol: 'openai-chat' as const },
  ];
  for (const { harness, protocol } of cases) {
    const plan = planSpawn(
      facts({
        harness,
        agent: {
          name: `a-${harness.name}`,
          harness: harness.name,
          provider: { ...provider, protocol },
        },
        storeEnv: { GW_KEY: secret, MCP_TOKEN: 'mcp-secret' },
        mcpServers: [remoteMcp],
      })
    );
    const files = [
      ...(plan.agentImagePlan?.files ?? []).map(f => f.content),
      plan.configOverlay?.file.content ?? '',
    ];
    for (const content of files) {
      assert.doesNotMatch(content, /sk-run-9f8e7d6c|mcp-secret/, harness.name);
    }
    assert.ok(
      files.some(c => c.includes('GW_KEY')),
      harness.name
    );
  }
});

test('planSpawn: a default Codex agent still gets the secret policy, its required key excluded', () => {
  // No provider and no --mcp: nothing is baked, yet Codex would snapshot the
  // env and hand the shell the key an --env-file brought (#206).
  const plan = planSpawn(
    facts({
      harness: HARNESSES.codex,
      agent: { name: 'codex', harness: 'codex' },
    })
  );
  const content = plan.configOverlay?.file.content ?? '';
  assert.equal(plan.configOverlay?.mountTo, '/home/node/.codex/config.toml');
  assert.match(content, /^shell_snapshot = false$/m);
  assert.match(content, /^exclude = \["OPENAI_API_KEY"\]$/m);
  assert.doesNotMatch(content, /mcp_servers/);
});

test('planSpawn: one Codex exclude list holds the provider key, the required key and every MCP header var', () => {
  const plan = planSpawn(
    facts({
      harness: HARNESSES.codex,
      agent: {
        name: 'gw-codex',
        harness: 'codex',
        provider: {
          baseUrl: 'https://gw.example.com/v1',
          model: 'm',
          protocol: 'openai-responses',
          apiKeyEnv: 'GW_KEY',
        },
      },
      storeEnv: { GW_KEY: 'k', MCP_TOKEN: 't' },
      mcpServers: [
        {
          name: 'hosted',
          transport: 'remote',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
          requiredEnv: ['MCP_TOKEN'],
        },
      ],
    })
  );
  const content = plan.configOverlay?.file.content ?? '';
  assert.match(
    content,
    /^exclude = \["GW_KEY", "OPENAI_API_KEY", "MCP_TOKEN"\]$/m
  );
  assert.equal(content.match(/^\[shell_environment_policy\]$/gm)?.length, 1);
});

test('planSpawn: pi gets no overlay without --mcp', () => {
  const plan = planSpawn(
    facts({ harness: HARNESSES.pi, agent: { name: 'pi', harness: 'pi' } })
  );
  assert.equal(plan.configOverlay, undefined);
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
    agent: { name: 'codex', harness: 'codex' },
    mcpServers: [containerMcp],
  });
  const plan = planSpawn(f);
  assert.deepEqual(plan.mcpArgs, []);
  assert.ok(plan.configOverlay);
  assert.equal(plan.configOverlay?.mountTo, '/home/node/.codex/config.toml');
});
test('planSpawn: a file-MCP harness (pi) delivers a mcp.json overlay via its adapter', () => {
  const f = facts({
    harness: HARNESSES.pi,
    agent: { name: 'pi', harness: 'pi' },
    mcpServers: [containerMcp],
  });
  const plan = planSpawn(f);
  assert.deepEqual(plan.mcpArgs, []);
  assert.ok(plan.configOverlay);
  assert.equal(plan.configOverlay?.mountTo, '/home/node/.pi/agent/mcp.json');
  const parsed = JSON.parse(plan.configOverlay!.file.content);
  assert.ok(parsed.mcpServers.everything);
});

test('planSpawn: a sidecar credential is rendered from storeEnv', () => {
  const plan = planSpawn(
    facts({ mcpServers: [secretMcp], storeEnv: { SECRET_TOKEN: 'tok' } })
  );
  assert.equal(plan.sidecarCredentials.secret, 'SECRET_TOKEN=tok\n');
});

test('planSpawn: a missing sidecar credential is a hard error', () => {
  assert.throws(
    () => planSpawn(facts({ mcpServers: [secretMcp], storeEnv: {} })),
    /MCP server "secret"[\s\S]*SECRET_TOKEN[\s\S]*not set in \.e\/\.env/
  );
});

test('planSpawn: a bare run whitelists only the template global base URLs', () => {
  const plan = planSpawn(facts({}));
  assert.deepEqual(plan.baseEnvWhitelist, [...GLOBAL_BASE_URL_ENV]);
});

test('planSpawn: whitelist adds the provider key and base-URL env names', () => {
  const plan = planSpawn(
    facts({
      agent: {
        name: 'x',
        harness: 'claudeCode',
        provider: {
          baseUrl: 'https://h',
          baseUrlEnv: 'MY_BASE_URL',
          model: 'auto/coding',
          protocol: 'anthropic-messages',
          apiKeyEnv: 'MY_KEY',
        },
      },
      storeEnv: { MY_KEY: 'sk-abc', MY_BASE_URL: 'https://h' },
    })
  );
  assert.ok(plan.baseEnvWhitelist.includes('MY_KEY'));
  assert.ok(plan.baseEnvWhitelist.includes('MY_BASE_URL'));
  // Neither the harness sections nor unrelated store keys are whitelisted.
  assert.deepEqual(
    [...plan.baseEnvWhitelist].filter(k => /MY_/.test(k)).sort(),
    ['MY_BASE_URL', 'MY_KEY']
  );
});

test('planSpawn: whitelist adds requiredEnv of container and remote MCP servers', () => {
  const plan = planSpawn(
    facts({
      mcpServers: [secretMcp, remoteSecretMcp],
      storeEnv: { SECRET_TOKEN: 'a', REMOTE_TOKEN: 'b' },
    })
  );
  assert.ok(plan.baseEnvWhitelist.includes('SECRET_TOKEN'));
  assert.ok(plan.baseEnvWhitelist.includes('REMOTE_TOKEN'));
});

test('planSpawn: a never-forwarded env name is refused, whoever declares it', () => {
  // The rule (#153): opencode's `--share` publishes the whole session
  // transcript - prompt and every quoted file - at `opncd.ai/s/<id>`, and
  // `OPENCODE_AUTO_SHARE` turns it on by environment alone. Nothing may carry
  // it into a container, and a declaration that tries is a loud error rather
  // than a silent drop.
  const sharingMcp: McpServer = {
    name: 'sharing',
    transport: 'container',
    port: 3003,
    requiredEnv: ['OPENCODE_AUTO_SHARE'],
  };
  assert.throws(
    () =>
      planSpawn(
        facts({
          mcpServers: [sharingMcp],
          storeEnv: { OPENCODE_AUTO_SHARE: 'true' },
        })
      ),
    /MCP server "sharing"[\s\S]*OPENCODE_AUTO_SHARE[\s\S]*never forwarded/
  );
  assert.throws(
    () =>
      planSpawn(
        facts({
          agent: {
            name: 'x',
            harness: 'claudeCode',
            provider: {
              baseUrl: 'https://h',
              model: 'auto/coding',
              protocol: 'anthropic-messages',
              apiKeyEnv: 'OPENCODE_AUTO_SHARE',
            },
          },
          storeEnv: { OPENCODE_AUTO_SHARE: 'true' },
        })
      ),
    /Agent "x"[\s\S]*OPENCODE_AUTO_SHARE[\s\S]*never forwarded/
  );
});

test('validateSpawn: a sibling cannot also declare a base', () => {
  assert.throws(
    () =>
      validateSpawn(
        facts({
          role: 'child',
          sibling: {
            id: 'sib-001',
            spoolDir: '/tmp/spool',
            parent: { worktreePath: '/tmp/p', branch: 'e/demo/p-1' },
          },
          base: { ref: 'refs/heads/main', sha: 'main-sha', branch: 'main' },
        })
      ),
    /cannot also declare a base/
  );
});

test('planSpawn: a one-shot payload is mounted read-only at /run/e/event.json', () => {
  // Outside /workspace, so it can never ride along in a commitAll (ADR-0016).
  const plan = planSpawn(facts({ eventFile: '/runner/temp/event.json' }));
  assert.deepEqual(plan.eventMount, {
    host: '/runner/temp/event.json',
    container: '/run/e/event.json',
    ro: true,
  });
  assert.equal(planSpawn(facts({})).eventMount, undefined);
});

test('planSpawn: baked skills go to the derived image; per-run skills become mounts', () => {
  const f = facts({
    bakedSkills: ['baked-skill'],
    perRunSkills: ['run-skill'],
  });
  const plan = planSpawn(f);
  assert.deepEqual(plan.agentImagePlan?.skillNames, ['baked-skill']);
  assert.equal(plan.skillMounts.length, 1);
  assert.equal(
    plan.skillMounts[0].container,
    '/home/node/.claude/skills/run-skill'
  );
  assert.equal(plan.skillMounts[0].ro, true);
});

// The role contract (ADR-0013, ticket 01): every agent container receives its
// role and broker endpoint as host-set `-e` env, decided purely in the plan.
test('planSpawn: a run is a parent by default, reaching the broker by alias', () => {
  const plan = planSpawn(facts({}));
  assert.deepEqual(plan.agentEnv, [
    'E_ROLE=parent',
    'E_BROKER_URL=http://runtime-broker:20130',
  ]);
  // The contract is `-e` only; it is never whitelisted out of `.e/.env`.
  assert.equal(plan.baseEnvWhitelist.includes('E_ROLE'), false);
});

test('planSpawn: a child run receives E_ROLE=child', () => {
  const plan = planSpawn(facts({ role: 'child' }));
  assert.ok(plan.agentEnv.includes('E_ROLE=child'));
  assert.equal(plan.agentEnv.includes('E_ROLE=parent'), false);
});

test('planSpawn: with the local stack the broker URL is on loopback', () => {
  const plan = planSpawn(facts({ localStackPresent: true }));
  assert.ok(plan.agentEnv.includes('E_BROKER_URL=http://localhost:20130'));
});

test('planSpawn: the host-set role contract follows the user -e entries', () => {
  const plan = planSpawn(facts({ env: ['FOO=bar'] }));
  assert.deepEqual(plan.agentEnv, [
    'FOO=bar',
    'E_ROLE=parent',
    'E_BROKER_URL=http://runtime-broker:20130',
  ]);
});

test('validateSpawn: a user -e on a never-forwarded variable is refused', () => {
  // The third way into the container, besides an agent provider and an MCP
  // server's requiredEnv: the user's own `-e`. The rule is only a rule if it
  // covers all three (#153).
  assert.throws(
    () => validateSpawn(facts({ env: ['OPENCODE_AUTO_SHARE=true'] })),
    /Cannot pass -e OPENCODE_AUTO_SHARE[\s\S]*publishes/
  );
  assert.doesNotThrow(() =>
    validateSpawn(facts({ env: ['OPENCODE_AUTO_SHARE_LOOKALIKE=true'] }))
  );
});

test('validateSpawn: a user -e on a role-contract variable is refused up front', () => {
  assert.throws(
    () => validateSpawn(facts({ env: ['E_ROLE=child'] })),
    /Cannot pass -e E_ROLE: e sets E_ROLE and E_BROKER_URL/
  );
  assert.throws(
    () => validateSpawn(facts({ env: ['FOO=1', 'E_BROKER_URL=http://x:1'] })),
    /Cannot pass -e E_BROKER_URL/
  );
  // Other keys, and the internal E_SPAWN_ROLE marker, are not the contract.
  assert.doesNotThrow(() =>
    validateSpawn(facts({ env: ['FOO=1', 'E_SPAWN_ROLE=child'] }))
  );
});

// The runtime-broker (ADR-0013) rides along exactly when the run carries the
// spawn-brother skill - the skill is how the agent learns to call it.
test('planSpawn: no spawn-brother skill, no broker sidecar', () => {
  assert.equal(planSpawn(facts({})).broker, undefined);
  assert.equal(
    planSpawn(facts({ perRunSkills: ['web-search'] })).broker,
    undefined
  );
});

test('planSpawn: the spawn-brother skill, per-run or baked, plans the broker sidecar', () => {
  const expected = defaultBrokerPlan();
  assert.deepEqual(
    planSpawn(facts({ perRunSkills: ['spawn-brother'] })).broker,
    expected
  );
  assert.deepEqual(
    planSpawn(facts({ bakedSkills: ['spawn-brother'] })).broker,
    expected
  );
  // The URL the agent gets names that same port.
  assert.ok(
    planSpawn(facts({ perRunSkills: ['spawn-brother'] })).agentEnv.includes(
      'E_BROKER_URL=http://runtime-broker:20130'
    )
  );
});

test("planSpawn: a child run gets no broker of its own - it inherits the parent's (ADR-0013)", () => {
  assert.equal(
    planSpawn(facts({ perRunSkills: ['spawn-brother'], role: 'child' })).broker,
    undefined
  );
  // The URL still names the (parent's) broker.
  assert.ok(
    planSpawn(
      facts({ perRunSkills: ['spawn-brother'], role: 'child' })
    ).agentEnv.includes('E_BROKER_URL=http://runtime-broker:20130')
  );
});

test('validateSpawn: a sibling spawn must carry the child role', () => {
  const sibling = {
    parent: { worktreePath: '/wt/parent', branch: 'e/demo/parent-1' },
    spoolDir: '/spool',
    id: 'sib-001',
  };
  assert.throws(
    () => validateSpawn(facts({ sibling })),
    /sibling sib-001 must carry E_SPAWN_ROLE=child/
  );
  assert.doesNotThrow(() => validateSpawn(facts({ sibling, role: 'child' })));
});

// ADR-0017: the session a Run keeps on the host, and resume.

test('planSpawn: a Run of a resumable harness plans a session with what the record needs', () => {
  const plan = planSpawn(
    facts({
      agent: {
        name: 'smart-pi',
        harness: 'pi',
        provider: {
          baseUrl: 'https://gw.example.com',
          model: 'opus',
          protocol: 'anthropic-messages',
          apiKeyEnv: 'GW_KEY',
        },
      },
      harness: HARNESSES.pi,
      storeEnv: { GW_KEY: 'k' },
      mcpServers: [containerMcp],
      perRunSkills: ['lint'],
      sessionStoreDir: '/root/.e',
    })
  );
  assert.deepEqual(plan.session, {
    agent: 'smart-pi',
    harness: 'pi',
    harnessVersion: HARNESSES.pi.version,
    provider: {
      baseUrl: 'https://gw.example.com',
      model: 'opus',
      protocol: 'anthropic-messages',
    },
    mcp: ['everything'],
    skills: ['lint'],
  });
});

/** A harness with no resume capability: every shipped one has it now. */
const noResume = { ...HARNESSES.claudeCode, resumeCommand: undefined };

test('planSpawn: no session for a harness that cannot resume, a sibling, or a Store-less run', () => {
  assert.equal(
    planSpawn(facts({ harness: noResume, sessionStoreDir: '/root/.e' }))
      .session,
    undefined
  );
  const pi = { agent: { name: 'pi', harness: 'pi' }, harness: HARNESSES.pi };
  assert.equal(planSpawn(facts({ ...pi })).session, undefined);
  assert.equal(
    planSpawn(facts({ ...pi, sessionStoreDir: '/root/.e', role: 'child' }))
      .session,
    undefined
  );
  assert.ok(planSpawn(facts({ ...pi, sessionStoreDir: '/root/.e' })).session);
});

test('validateSpawn: resume is refused on a harness that cannot, naming the ones that can', () => {
  const resume = {
    branch: 'e/demo/x-1',
    base: { sha: 's', branch: 'main' },
    elapsedMs: 0,
  };
  assert.throws(
    () => validateSpawn(facts({ harness: noResume, resume })),
    /Harness "claudeCode" cannot resume a session:.*e resume supports: pi, claudeCode, codex, opencode/
  );
  const pi = { agent: { name: 'pi', harness: 'pi' }, harness: HARNESSES.pi };
  assert.throws(
    () => validateSpawn(facts({ ...pi, resume })),
    /no Store to keep sessions in/
  );
  assert.doesNotThrow(() =>
    validateSpawn(facts({ ...pi, resume, sessionStoreDir: '/root/.e' }))
  );
  assert.throws(
    () =>
      validateSpawn(
        facts({
          ...pi,
          resume,
          sessionStoreDir: '/root/.e',
          base: { ref: 'refs/heads/main', sha: 's', branch: 'main' },
        })
      ),
    /continues its own branch/
  );
});
