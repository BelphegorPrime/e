import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARNESSES } from '../harness/index.js';
import { RUNTIME_CATALOGS } from './localRuntimes.js';
import { GIT_PLATFORMS } from '../store/config.js';
import { planInit, type InitState } from './initPlan.js';
import { defaultsWizard, type Wizard, type WizardState } from './wizard.js';

const WIZARD_STATE: WizardState = {
  harnessNames: Object.keys(HARNESSES),
  currentHarness: 'pi',
  promptKeys: ['ANTHROPIC_API_KEY'],
  askOmniroutePassword: true,
  runtimeCatalogs: RUNTIME_CATALOGS,
  currentModels: [],
  currentLocalRuntimes: ['llamacpp'],
  gitPlatforms: [...GIT_PLATFORMS],
  shells: ['bash', 'zsh', 'fish', 'powershell'],
};

function state(): InitState {
  return {
    root: undefined, // home directory; these tests never write
    harnessNames: WIZARD_STATE.harnessNames,
    currentDefaultHarness: WIZARD_STATE.currentHarness,
    currentModels: WIZARD_STATE.currentModels,
    currentLocalRuntimes: WIZARD_STATE.currentLocalRuntimes,
    existingEnvContent: undefined,
    runtimeCatalogs: WIZARD_STATE.runtimeCatalogs,
    gitPlatforms: [...GIT_PLATFORMS] as const,
    hardware: 'cpu',
  };
}

// The wizard seam is the scripted interface the plan is driven through: the
// live readline implementation is the only non-testable piece, and every
// decision it feeds (validation lives in the pure parsers, resolution in
// planInit) is covered elsewhere.

test('defaultsWizard: --yes and non-interactive runs keep every current value', async () => {
  const answers = await defaultsWizard.ask(WIZARD_STATE);
  assert.deepEqual(answers, {});
  // No OmniRoute password answer means the plan generates a random one.
  const plan = planInit(state(), answers);
  assert.equal(plan.defaultHarness, 'pi');
  assert.deepEqual(plan.models, []);
  // No answers means no keys to merge; the fresh store's stack secrets are
  // seeded as usual (and recorded as the plan's seeded additions).
  assert.deepEqual(plan.envValues, plan.secrets);
});

test('a scripted wizard answer with an OmniRoute password carries it into the plan', async () => {
  const scripted: Wizard = {
    async ask() {
      return {
        harness: 'pi',
        omniroutePassword: 'chosen-pass',
      };
    },
  };
  const answers = await scripted.ask(WIZARD_STATE);
  const plan = planInit(state(), answers);
  assert.equal(plan.envValues.OMNIROUTE_INITIAL_PASSWORD, 'chosen-pass');
  assert.equal(plan.secrets.OMNIROUTE_INITIAL_PASSWORD, 'chosen-pass');
});

test('a scripted wizard answer drives the plan the same way the live one does', async () => {
  const scripted: Wizard = {
    async ask() {
      return {
        harness: '2',
        models: 'none',
        apiKeys: { ANTHROPIC_API_KEY: 'sk-abc' },
      };
    },
  };
  const answers = await scripted.ask(WIZARD_STATE);
  const plan = planInit(state(), answers);
  assert.equal(plan.defaultHarness, WIZARD_STATE.harnessNames[1]);
  assert.deepEqual(plan.models, []);
  assert.equal(plan.envValues.ANTHROPIC_API_KEY, 'sk-abc');
});
