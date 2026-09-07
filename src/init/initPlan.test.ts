import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARNESSES } from '../harness/index.js';
import { MODEL_CATALOG } from '../modelStatus.js';
import { GIT_PLATFORMS } from '../store/config.js';
import {
  OMNIROUTE_STACK_SECRETS,
  parseGitPlatformChoice,
  planInit,
  type InitAnswers,
  type InitState,
} from './initPlan.js';

const HARNESS_NAMES = Object.keys(HARNESSES);

/** A fresh-state fixture: temp root, default favorite, no models, no `.env`. */
function state(overrides: Partial<InitState> = {}): InitState {
  return {
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'e-plan-')),
    harnessNames: HARNESS_NAMES,
    currentDefaultHarness: 'pi',
    currentModels: [],
    currentLocalRuntimes: ['llamacpp'],
    existingEnvContent: undefined,
    modelCatalog: MODEL_CATALOG,
    gitPlatforms: [...GIT_PLATFORMS],
    hardware: 'cpu',
    ...overrides,
  };
}

// The point of the plan: every write decision is pure and scriptable, so the
// interactive wizard, `--yes`, and a piped/CI run share one tested core.

test('planInit: blank or unanswered answers keep the configured current', () => {
  const plan = planInit(state(), {});
  assert.equal(plan.defaultHarness, 'pi');
  assert.deepEqual(plan.models, []);
  assert.deepEqual(plan.config, {
    defaultHarness: 'pi',
    models: [],
    localRuntimes: ['llamacpp'],
    gitPlatform: undefined,
  });
});

test('planInit: answers resolve through the same pure parsers the prompts use', () => {
  const plan = planInit(state(), {
    harness: '2',
    models: 'all',
  } satisfies InitAnswers);
  assert.equal(plan.defaultHarness, HARNESS_NAMES[1]);
  assert.deepEqual(
    plan.models,
    MODEL_CATALOG.map(m => m.id)
  );
});

test('planInit: local runtime selection supports none and omits llama provisioning', () => {
  const plan = planInit(state(), { localRuntimes: 'none' });
  assert.deepEqual(plan.localRuntimes, []);
  assert.deepEqual(plan.config.localRuntimes, []);
  assert.equal(
    plan.steps.some(step => step.kind === 'bootstrap'),
    false
  );
  const compose = plan.steps.find(step => step.kind === 'compose');
  assert.ok(compose && !compose.write.content.includes('\n  llama:'));
});

test('planInit: local runtime selection accepts indexed multi-select', () => {
  assert.deepEqual(planInit(state(), { localRuntimes: '1,1' }).localRuntimes, [
    'llamacpp',
  ]);
});

test('planInit: a named git platform is recorded in the config', () => {
  const plan = planInit(state(), {
    gitPlatform: 'gitlab',
  } satisfies InitAnswers);
  assert.equal(plan.gitPlatform, 'gitlab');
  assert.deepEqual(plan.config, {
    defaultHarness: 'pi',
    models: [],
    localRuntimes: ['llamacpp'],
    gitPlatform: 'gitlab',
  });
});

test('planInit: a blank git-platform answer disables PR/MR creation', () => {
  const plan = planInit(state({ currentGitPlatform: 'github' }), {
    gitPlatform: '   ',
  } satisfies InitAnswers);
  assert.equal(plan.gitPlatform, undefined);
});

test('planInit: an unanswered platform keeps the configured current (a --yes re-init)', () => {
  const plan = planInit(state({ currentGitPlatform: 'gitea' }), {});
  assert.equal(plan.gitPlatform, 'gitea');
});

test('parseGitPlatformChoice: index, exact name, blank, and invalid', () => {
  const platforms = ['github', 'gitlab', 'forgejo', 'gitea'];
  assert.equal(parseGitPlatformChoice('2', platforms), 'gitlab');
  assert.equal(parseGitPlatformChoice('forgejo', platforms), 'forgejo');
  // A blank answer is the disable sentinel (valid, resolved by the caller).
  assert.equal(parseGitPlatformChoice('', platforms), undefined);
  assert.equal(parseGitPlatformChoice('  ', platforms), undefined);
  // Anything else is unrecognized (re-prompt).
  assert.equal(parseGitPlatformChoice('bitbucket', platforms), undefined);
  assert.equal(parseGitPlatformChoice('5', platforms), undefined);
  assert.equal(parseGitPlatformChoice('-1', platforms), undefined);
});

test('planInit: a raw-mode id list passes through untouched', () => {
  const ids = MODEL_CATALOG.slice(0, 2).map(m => m.id);
  const plan = planInit(state(), { models: ids } satisfies InitAnswers);
  assert.deepEqual(plan.models, ids);
});

test('planInit: collected API keys merge into the env and fill blank lines', () => {
  const plan = planInit(
    state({
      existingEnvContent:
        '# --- pi ---\nANTHROPIC_API_KEY=\nOPENAI_API_KEY=filled\n',
    }),
    { apiKeys: { ANTHROPIC_API_KEY: 'sk-abc' } } satisfies InitAnswers
  );
  assert.equal(plan.envValues.ANTHROPIC_API_KEY, 'sk-abc');
  assert.equal(plan.envValues.OPENAI_API_KEY, 'filled');
  assert.match(plan.env.content, /ANTHROPIC_API_KEY=sk-abc/);
  assert.match(plan.env.content, /OPENAI_API_KEY=filled/);
});

test('planInit: a fresh store creates the env with the omniroute section seeded', () => {
  const plan = planInit(state(), {});
  assert.equal(plan.env.created, true);
  assert.equal(plan.env.changed, false);
  assert.match(plan.env.content, /# --- e-net ---/);
  for (const key of OMNIROUTE_STACK_SECRETS) {
    assert.equal(
      plan.envValues[key],
      plan.secrets[key],
      `${key} should be seeded on a fresh store`
    );
    assert.match(plan.envValues[key], /^[0-9a-f]+$/);
  }
});

test('planInit: a user-provided omniroutePassword is kept and never rotated', () => {
  const plan = planInit(state(), { omniroutePassword: 'chosen-pass' });
  assert.equal(plan.envValues.OMNIROUTE_INITIAL_PASSWORD, 'chosen-pass');
  assert.equal(plan.secrets.OMNIROUTE_INITIAL_PASSWORD, 'chosen-pass');
  // Other stack secrets are still seeded randomly.
  assert.match(plan.secrets.JWT_SECRET, /^[0-9a-f]+$/);
});

test('planInit: a blank omniroutePassword produces a random hex password', () => {
  const plan = planInit(state(), { omniroutePassword: '' });
  assert.match(plan.envValues.OMNIROUTE_INITIAL_PASSWORD, /^[0-9a-f]{32}$/);
});

test('planInit: re-init never rotates a set stack secret and stays up to date', () => {
  // A hand-edited env keeps its own stack values on the next init.
  const handEdited = state({
    existingEnvContent: `OMNIROUTE_INITIAL_PASSWORD=user-picked\nJWT_SECRET=\nAPI_KEY_SECRET=\n`,
  });
  const second = planInit(handEdited, {});
  assert.equal(second.envValues.OMNIROUTE_INITIAL_PASSWORD, 'user-picked');
  assert.equal(second.secrets.OMNIROUTE_INITIAL_PASSWORD, 'user-picked');
  assert.match(second.envValues.JWT_SECRET, /^[0-9a-f]{64}$/);
  assert.match(second.envValues.API_KEY_SECRET, /^[0-9a-f]{64}$/);

  // An env that already carries every section header is left byte-identical:
  // the append + apply path is a pure no-op for a stable store.
  const first = planInit(state(), {});
  const withHeaders =
    first.env.content +
    Object.keys(HARNESSES)
      .map(name => `# --- ${name} ---\n\n`)
      .join('');
  const replay = planInit(
    {
      ...state(),
      existingEnvContent: withHeaders,
      currentDefaultHarness: first.defaultHarness,
      currentModels: first.models,
    },
    {}
  );
  assert.equal(replay.env.created, false);
  assert.equal(replay.env.changed, false);
  assert.equal(replay.env.content, withHeaders);
});

test('planInit: steps are ordered — harnesses, shipped servers, bootstrap, then compose', () => {
  const plan = planInit(state(), {});
  const kinds = plan.steps.map(step => step.kind);
  assert.deepEqual(kinds, [
    ...HARNESS_NAMES.map(() => 'harness'),
    'writes', // shipped MCP servers + skills
    'writes', // egress build context + blacklist template (ADR-0011)
    'bootstrap',
    'compose',
  ]);

  // The first harness pair: dockerfile before agents, both never clobbered.
  const first = plan.steps[0];
  assert.equal(first.kind, 'harness');
  assert.equal(first.name, HARNESS_NAMES[0]);
  // First harness's Dockerfile, then its default agent definition.
  const [dockerfile, agent] = first.writes;
  assert.equal(dockerfile.clobber, 'never');
  assert.equal(agent.clobber, 'never');
  assert.ok(
    dockerfile.file.endsWith('.e/harnesses/' + first.name + '/Dockerfile')
  );
  assert.ok(agent.file.endsWith('.e/agents/' + first.name + '/agent.json'));

  // Bootstrap and Compose are derived state (always rewritten).
  const bootstrap = plan.steps.find(s => s.kind === 'bootstrap');
  const compose = plan.steps.find(s => s.kind === 'compose');
  assert.equal(bootstrap?.write.clobber, 'always');
  assert.equal(compose?.write.clobber, 'always');
  assert.ok(bootstrap?.write.file.endsWith('.e/bootstrap.sh'));
  assert.ok(compose?.write.file.endsWith('.e/compose.yaml'));
});

test('planInit: all paths live under the requested root', () => {
  const plan = planInit({ ...state(), root: '/tmp/fake-e-root' }, {});
  for (const step of plan.steps) {
    for (const write of 'writes' in step ? step.writes : [step.write]) {
      assert.ok(write.file.startsWith('/tmp/fake-e-root'));
    }
  }
  assert.ok(plan.env.file.startsWith('/tmp/fake-e-root'));
});

test('planInit: seeds the egress build context and blacklist template (never clobbered)', () => {
  const plan = planInit(state(), {});
  const egressStep = plan.steps.find(
    step =>
      step.kind === 'writes' &&
      step.writes.some(w => w.file.includes('.e/egress/'))
  );
  assert.ok(egressStep, 'expected an egress write step');
  assert.ok(egressStep.kind === 'writes');
  const files = egressStep.writes.map(w => w.file);
  assert.ok(files.some(f => f.endsWith('.e/egress/Dockerfile')));
  assert.ok(files.some(f => f.endsWith('.e/egress/entrypoint.sh')));
  assert.ok(files.some(f => f.endsWith('.e/egress/dnsmasq.conf')));
  assert.ok(files.some(f => f.endsWith('.e/egress-blacklist')));
  for (const write of egressStep.writes) {
    assert.equal(write.clobber, 'never');
  }
});
