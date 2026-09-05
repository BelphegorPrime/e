import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARNESSES } from '../harness/index';
import { MODEL_CATALOG } from '../modelStatus';
import { planInit, type InitState } from './initPlan';
import { defaultsWizard, type Wizard, type WizardState } from './wizard';

const WIZARD_STATE: WizardState = {
  harnessNames: Object.keys(HARNESSES),
  currentHarness: 'pi',
  promptKeys: ['ANTHROPIC_API_KEY'],
  modelCatalog: MODEL_CATALOG,
  currentModels: [],
};

function state(): InitState {
  return {
    root: undefined, // home directory; these tests never write
    harnessNames: WIZARD_STATE.harnessNames,
    currentDefaultHarness: WIZARD_STATE.currentHarness,
    currentModels: WIZARD_STATE.currentModels,
    existingEnvContent: undefined,
    modelCatalog: WIZARD_STATE.modelCatalog,
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
  const plan = planInit(state(), answers);
  assert.equal(plan.defaultHarness, 'pi');
  assert.deepEqual(plan.models, []);
  // No answers means no keys to merge; the fresh store's stack secrets are
  // seeded as usual (and recorded as the plan's seeded additions).
  assert.deepEqual(plan.envValues, plan.secrets);
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