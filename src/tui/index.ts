import { formatBytes, type ModelCatalogEntry } from '../modelStatus.js';
import { type InitAnswers } from '../init/initPlan.js';
import { type WizardState } from '../init/wizard.js';
import {
  LOCAL_RUNTIMES,
  composeModelCatalog,
  type LocalRuntime,
} from '../init/localRuntimes.js';
import { type MenuRow, type MenuResult } from './settings.js';

const GIT_DISABLED = '(disabled)';

/**
 * Derives the settings-menu rows from the partial answer.
 *
 * Rows are recomputed on every render, so the model list tracks the
 * currently selected runtimes: toggling a runtime off drops its models
 * from the menu immediately.
 */
export function buildInitRows(
  state: WizardState,
  partial: MenuResult
): MenuRow[] {
  const selectedRuntimes = ((partial.localRuntimes as string[] | undefined) ??
    state.currentLocalRuntimes) as LocalRuntime[];

  const selectedModels =
    (partial.models as string[] | undefined) ?? state.currentModels;

  const rows: MenuRow[] = [
    { kind: 'header', label: 'Local AI runtimes' },

    ...LOCAL_RUNTIMES.map(runtime => ({
      kind: 'checkbox' as const,
      id: runtime.id,
      target: 'localRuntimes',
      label: runtime.label,
      hint: runtime.id,
      checked: selectedRuntimes.includes(runtime.id),
    })),

    { kind: 'header', label: 'Local models to provision' },

    ...composeModelCatalog(selectedRuntimes, state.runtimeCatalogs).map(
      (model: ModelCatalogEntry) => ({
        kind: 'checkbox' as const,
        id: model.id,
        target: 'models',
        label: model.id,
        hint: formatBytes(model.sizeBytes),
        checked: selectedModels.includes(model.id),
      })
    ),

    {
      kind: 'header',
      label: 'Favorite harness (used when `e spawn` names none)',
    },

    {
      kind: 'cycle' as const,
      id: 'harness',
      target: 'harness',
      label: 'Harness',
      value: (partial.harness as string | undefined) ?? state.currentHarness,
      values: state.harnessNames,
    },

    {
      kind: 'header',
      label: 'Git platform (creates a PR/MR on a successful run)',
    },

    {
      kind: 'cycle' as const,
      id: 'gitPlatform',
      target: 'gitPlatform',
      label: 'Git platform',
      value:
        (partial.gitPlatform as string | undefined) ??
        state.currentGitPlatform ??
        GIT_DISABLED,
      values: [...state.gitPlatforms, GIT_DISABLED],
    },

    { kind: 'header', label: 'Shell (used for completion setup)' },

    {
      kind: 'cycle' as const,
      id: 'shell',
      target: 'shell',
      label: 'Shell',
      value: (partial.shell as string | undefined) ?? state.shells[0],
      values: state.shells,
    },
  ];

  return rows;
}

/**
 * Maps a menu result onto the answer shape `planInit` consumes.
 *
 * Checkbox targets are preserved even when their arrays are empty.
 * This is important because an empty selection is a valid choice,
 * e.g. "no local AI runtimes".
 *
 * The git platform disabled sentinel maps back to the blank-answer
 * representation expected by planInit.
 */
export function applyMenuResult(
  result: MenuResult,
  state: WizardState
): InitAnswers {
  const answers: InitAnswers = {};

  const runtimes = result.localRuntimes as string[] | undefined;
  const models = result.models as string[] | undefined;
  const harness = result.harness as string | undefined;
  const gitPlatform = result.gitPlatform as string | undefined;
  const shell = result.shell as string | undefined;

  if (runtimes !== undefined) {
    answers.localRuntimes = runtimes as LocalRuntime[];
  }

  if (models !== undefined) {
    answers.models = models;
  }

  if (harness !== undefined && harness.length > 0) {
    answers.harness = harness;
  }

  if (gitPlatform !== undefined && gitPlatform !== GIT_DISABLED) {
    answers.gitPlatform = gitPlatform;
  } else if (gitPlatform === GIT_DISABLED && state.currentGitPlatform) {
    // Explicitly disabling PR/MR; planInit maps '' to undefined.
    answers.gitPlatform = '';
  }

  if (shell !== undefined && shell.length > 0) {
    answers.shell = shell;
  }

  return answers;
}
