import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARNESSES } from '../harness/index.js';
import { RUNTIME_CATALOGS } from '../init/localRuntimes.js';
import { GIT_PLATFORMS } from '../store/config.js';
import { type WizardState } from '../init/wizard.js';
import { applyMenuResult, buildInitRows } from './index.js';

const WIZARD_STATE: WizardState = {
  harnessNames: Object.keys(HARNESSES),
  currentHarness: 'pi',
  promptKeys: ['ANTHROPIC_API_KEY'],
  askOmniroutePassword: true,
  runtimeCatalogs: RUNTIME_CATALOGS,
  currentModels: ['llama3.1-8b'],
  currentLocalRuntimes: ['llamacpp'],
  gitPlatforms: [...GIT_PLATFORMS],
  shells: ['bash', 'zsh', 'fish', 'powershell'],
};

// buildInitRows / applyMenuResult are the testable seam of the raw-mode menu:
// the host loop (runSettingsMenu) is stdin-driven, so every decision it feeds
// is covered here, exactly like the readline wizard's parsers.

test('buildInitRows: model rows track the selected runtimes', () => {
  const rows = buildInitRows(WIZARD_STATE, {});
  const runtimes = rows.filter(
    (r): r is Extract<typeof r, { kind: 'checkbox' }> =>
      r.kind === 'checkbox' && r.target === 'localRuntimes'
  );
  const runtimesOn = runtimes.filter(r => r.checked);
  assert.deepEqual(
    runtimesOn.map(r => r.id),
    ['llamacpp']
  );
  // Models come from the llamacpp catalog only (the selected runtime).
  const modelRows = rows.filter(
    (r): r is Extract<typeof r, { kind: 'checkbox' }> =>
      r.kind === 'checkbox' && r.target === 'models'
  );
  assert.ok(modelRows.length > 0);
  assert.ok(
    modelRows.every(r => RUNTIME_CATALOGS.llamacpp.some(m => m.id === r.id))
  );
});

test('buildInitRows: toggling a runtime off drops its models', () => {
  // Partial answer with no runtimes selected — the model list must be empty.
  const rows = buildInitRows(WIZARD_STATE, { localRuntimes: [] });
  const modelRows = rows.filter(
    (r): r is Extract<typeof r, { kind: 'checkbox' }> =>
      r.kind === 'checkbox' && r.target === 'models'
  );
  assert.equal(modelRows.length, 0);
});

test('applyMenuResult: marks flow into planInit answer slots', () => {
  const result = {
    localRuntimes: ['ollama', 'vllm'],
    models: ['llama3.1-8b'],
    harness: 'claude-code',
    gitPlatform: 'github',
  };
  const answers = applyMenuResult(result, WIZARD_STATE);
  assert.deepEqual(answers.localRuntimes, ['ollama', 'vllm']);
  assert.deepEqual(answers.models, ['llama3.1-8b']);
  assert.equal(answers.harness, 'claude-code');
  assert.equal(answers.gitPlatform, 'github');
});

test('buildInitRows: shell cycle row defaults to the first shell', () => {
  const rows = buildInitRows(WIZARD_STATE, {});
  const shellRow = rows.find(
    (r): r is Extract<typeof r, { kind: 'cycle' }> =>
      r.kind === 'cycle' && r.target === 'shell'
  );
  assert.ok(shellRow);
  assert.equal(shellRow.value, 'bash');
  assert.deepEqual(shellRow.values, WIZARD_STATE.shells);
});

test('applyMenuResult: shell flows into the answer', () => {
  const answers = applyMenuResult({ shell: 'fish' }, WIZARD_STATE);
  assert.equal(answers.shell, 'fish');
});

test("applyMenuResult: disabled git platform maps to the '' answer", () => {
  const answers = applyMenuResult(
    { gitPlatform: '(disabled)' },
    { ...WIZARD_STATE, currentGitPlatform: 'github' }
  );
  assert.equal(answers.gitPlatform, '');
});

test('applyMenuResult: unchecked marks stay absent from the answers', () => {
  const answers = applyMenuResult({}, WIZARD_STATE);
  assert.equal(answers.localRuntimes, undefined);
  assert.equal(answers.models, undefined);
  assert.equal(answers.harness, undefined);
});
