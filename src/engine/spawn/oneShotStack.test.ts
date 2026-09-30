import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARNESSES } from '../../core/harness/index.js';
import { DEFAULT_LOOP_CAPS } from '../../core/store/config.js';
import {
  EGRESS_CONTAINER,
  OMNIROUTE_CONTAINER,
  OMNIROUTE_PORT,
} from '../../shared/constants.js';
import type { SpawnFacts } from './spawnPlan.js';
import { planSpawn } from './spawnPlan.js';
import {
  RUN_KEY_EXPIRY_MARGIN_MS,
  prepareOneShotStack,
  type OneShotStackDeps,
} from './oneShotStack.js';
import { fakeOmniRoute, type FakeKey } from './omniRoute.testSupport.js';

// A one-shot run on a host whose local stack is already up (ADR-0016
// section 13, #200): the stack is used, never started, and a provider that
// targets OmniRoute gets a key minted for this run alone and deleted after it.

const localProvider = {
  name: 'omniroute',
  baseUrl: `http://127.0.0.1:${OMNIROUTE_PORT}/v1`,
  apiKeyEnv: 'OPENAI_API_KEY',
  protocol: 'openai-chat' as const,
  model: 'auto',
};
const hostedProvider = {
  name: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  protocol: 'anthropic-messages' as const,
  model: 'auto',
};

const NOW = new Date('2026-09-30T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function facts(overrides: Partial<SpawnFacts> = {}): SpawnFacts {
  return {
    root: '/scratch/base-store',
    agent: { name: 'pr-fixer', harness: 'pi', provider: localProvider },
    harness: HARNESSES.pi,
    storeEnv: { OMNIROUTE_INITIAL_PASSWORD: 'pw' },
    storeEnvFile: '/runner/tmp/e.env',
    mcpServers: [],
    perRunSkills: [],
    bakedSkills: [],
    prompt: 'fix it',
    localStackPresent: false,
    rebuild: true,
    name: 'nightly',
    env: [],
    worktreesDir: '/tmp/e-worktrees',
    siblingArtifacts: [],
    maxSiblings: 3,
    localRuntimes: [],
    loop: DEFAULT_LOOP_CAPS,
    oneShotShape: true,
    ...overrides,
  };
}

/** A runtime where the named containers are running; records every other call it would need. */
function runtimeWith(running: string[]) {
  const calls: string[] = [];
  const runtime = {
    isRunning: (name: string) => running.includes(name),
    composeUp: () => {
      calls.push('composeUp');
    },
  };
  return { runtime, calls };
}

const stackUp = [EGRESS_CONTAINER, OMNIROUTE_CONTAINER];

function deps(
  running: string[],
  omni = fakeOmniRoute({ password: 'pw' })
): { deps: OneShotStackDeps; omni: typeof omni; calls: string[] } {
  const { runtime, calls } = runtimeWith(running);
  return {
    deps: { runtime, fetchImpl: omni.fetchImpl, now: () => NOW },
    omni,
    calls,
  };
}

test('prepareOneShotStack: with egress and omniroute running, the run joins the stack and never starts it', async () => {
  const d = deps(stackUp);
  const prepared = await prepareOneShotStack(
    facts({ agent: { name: 'a', harness: 'pi', provider: hostedProvider } }),
    d.deps
  );
  assert.equal(prepared.facts.localStackPresent, true);
  assert.deepEqual(d.calls, [], 'no composeUp');
  // A hosted provider needs no key: nothing is asked of OmniRoute.
  assert.deepEqual(d.omni.calls, []);
});

test('prepareOneShotStack: a stack is present only when both containers run; else no stack, no key', async () => {
  for (const running of [[], [EGRESS_CONTAINER], [OMNIROUTE_CONTAINER]]) {
    const d = deps(running);
    const prepared = await prepareOneShotStack(facts(), d.deps);
    assert.equal(prepared.facts.localStackPresent, false, running.join(','));
    assert.deepEqual(prepared.facts.storeEnv, facts().storeEnv);
    assert.deepEqual(d.omni.calls, []);
    await prepared.release();
  }
});

test('prepareOneShotStack: mints a key named after the run, expiring after the cap, before the container starts', async () => {
  const d = deps(stackUp);
  const prepared = await prepareOneShotStack(
    facts({
      storeEnv: {
        OMNIROUTE_INITIAL_PASSWORD: 'pw',
        OPENAI_API_KEY: 'sk-stale',
      },
    }),
    d.deps
  );
  assert.equal(d.omni.keys.length, 1);
  const [key] = d.omni.keys;
  assert.equal(key.name, 'e-run-nightly');
  assert.equal(
    key.expiresAt,
    new Date(
      NOW.getTime() +
        DEFAULT_LOOP_CAPS.totalTimeoutMs +
        RUN_KEY_EXPIRY_MARGIN_MS
    ).toISOString()
  );
  // The run's key replaces whatever the env-file held under the provider's name.
  assert.equal(prepared.facts.storeEnv.OPENAI_API_KEY, key.key);
  assert.equal(prepared.facts.localStackPresent, true);
});

test('prepareOneShotStack: release deletes the run key, and a second release is harmless', async () => {
  const d = deps(stackUp);
  const prepared = await prepareOneShotStack(facts(), d.deps);
  assert.equal(d.omni.keys.length, 1);
  await prepared.release();
  assert.deepEqual(d.omni.keys, []);
  await prepared.release();
  const deletes = d.omni.calls.filter(c => c.method === 'DELETE');
  assert.equal(deletes.length, 1);
});

test('prepareOneShotStack: a delete that fails does not throw: the key expires on its own and the next start sweeps it', async () => {
  const omni = fakeOmniRoute({
    password: 'pw',
    fail: { 'DELETE /api/keys/minted-1': 500 },
  });
  const d = deps(stackUp, omni);
  const prepared = await prepareOneShotStack(facts(), d.deps);
  await prepared.release();
  assert.equal(omni.keys.length, 1);
});

test('prepareOneShotStack: sweeps leftover e-run-* keys older than the cap before minting', async () => {
  const leftover = (
    id: string,
    createdAt: string,
    name = `e-run-${id}`
  ): FakeKey => ({
    id,
    name,
    key: `sk-${id}-0000`,
    createdAt,
    expiresAt: null,
  });
  const omni = fakeOmniRoute({
    password: 'pw',
    keys: [
      leftover('crashed', new Date(NOW.getTime() - 4 * HOUR).toISOString()),
      leftover('concurrent', new Date(NOW.getTime() - 1 * HOUR).toISOString()),
      leftover('human', '2026-01-01T00:00:00.000Z', 'laptop'),
    ],
  });
  const d = deps(stackUp, omni);
  await prepareOneShotStack(facts(), d.deps);
  assert.deepEqual(
    omni.keys.map(k => k.id),
    ['concurrent', 'human', 'minted-1']
  );
  const firstPost = omni.calls.findIndex(
    c => c.method === 'POST' && c.path === '/api/keys'
  );
  const sweep = omni.calls.findIndex(c => c.method === 'DELETE');
  assert.ok(sweep !== -1 && sweep < firstPost, 'sweep before mint');
});

test('prepareOneShotStack: without OMNIROUTE_INITIAL_PASSWORD the error names what to add, and nothing prompts', async () => {
  const d = deps(stackUp);
  await assert.rejects(
    prepareOneShotStack(facts({ storeEnv: {} }), d.deps),
    /add OMNIROUTE_INITIAL_PASSWORD to \/runner\/tmp\/e\.env/
  );
  await assert.rejects(
    prepareOneShotStack(
      facts({ storeEnv: {}, storeEnvFile: undefined }),
      d.deps
    ),
    /pass --env-file with OMNIROUTE_INITIAL_PASSWORD/
  );
  assert.deepEqual(d.omni.calls, []);
});

test('prepareOneShotStack: a rejected password or an unreachable gateway fails the run', async () => {
  const wrong = deps(stackUp, fakeOmniRoute({ password: 'other' }));
  await assert.rejects(
    prepareOneShotStack(facts(), wrong.deps),
    /rejected OMNIROUTE_INITIAL_PASSWORD/
  );
  const down = deps(
    stackUp,
    fakeOmniRoute({ password: 'pw', unreachable: true })
  );
  await assert.rejects(
    prepareOneShotStack(facts(), down.deps),
    /OmniRoute is not reachable/
  );
});

test('prepareOneShotStack: the admin password stays host-side, the run key reaches the container', async () => {
  const d = deps(stackUp);
  const prepared = await prepareOneShotStack(facts(), d.deps);
  const plan = planSpawn(prepared.facts);
  assert.equal(
    plan.baseEnvWhitelist.includes('OMNIROUTE_INITIAL_PASSWORD'),
    false
  );
  assert.ok(plan.baseEnvWhitelist.includes('OPENAI_API_KEY'));
  assert.doesNotMatch(plan.providerEnvContent ?? '', /pw/);
});
