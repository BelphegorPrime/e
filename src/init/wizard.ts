import {
  isTuiAvailable,
  MenuCancelledError,
  runSettingsMenu,
  type MenuResult,
} from '../tui/settings.js';
import { applyMenuResult, buildInitRows } from '../tui/index.js';
import path from 'path';
import * as readline from 'node:readline/promises';
import * as readlineSync from 'node:readline';
import { setImmediate } from 'node:timers';
import { formatBytes, type ModelCatalogEntry } from '../modelStatus.js';
import { log } from '../utils/log.js';
import {
  parseHarnessChoice,
  parseModelChoice,
  parseGitPlatformChoice,
  resolveLocalRuntimes,
  type InitAnswers,
} from './initPlan.js';
import {
  LOCAL_RUNTIMES,
  composeModelCatalog,
  type LocalRuntime,
} from './localRuntimes.js';

/** What the `e init` wizard needs to know to ask its questions. */
export interface WizardState {
  /** Favorite-harness names in prompt order. */
  harnessNames: string[];
  /** Configured favorite, preselected (a blank answer keeps it). */
  currentHarness: string;
  /** API keys worth prompting for (already-set keys were filtered out). */
  promptKeys: string[];
  /**
   * Whether to ask for the OmniRoute dashboard sign-in password, only when
   * `OMNIROUTE_INITIAL_PASSWORD` is unset/blank in `.e/.env`. A set password
   * is never re-asked and never rotated.
   */
  askOmniroutePassword: boolean;
  /** Per-runtime model catalogs; the model prompt only offers the selected runtimes'. */
  runtimeCatalogs: Readonly<Record<LocalRuntime, readonly ModelCatalogEntry[]>>;
  /** Configured model selection, preselected (a blank answer keeps it). */
  currentModels: string[];
  /** Configured local runtimes, preselected (a blank answer keeps them). */
  currentLocalRuntimes: LocalRuntime[];
  /** All git platforms offered, in prompt order. */
  gitPlatforms: string[];
  /** Configured git platform, preselected (a blank answer disables PR/MR). */
  currentGitPlatform?: string;
  /** Supported shells. */
  shells: string[];
  /** Installation directory. */
  root: string;
}

/**
 * The user-interaction seam of `e init`. Everything about what gets written is
 * decided by `planInit`; a wizard only collects answers. Three implementations:
 * the live readline wizard, the `--yes` defaults wizard, and (in tests) any
 * scripted object satisfying this interface — so the answers that drive a
 * plan's decisions are themselves scriptable and asserted.
 */
export interface Wizard {
  ask(state: WizardState): Promise<InitAnswers>;
}

/** The `--yes`/non-interactive wizard: no questions, keep every current value. */
export const defaultsWizard: Wizard = {
  async ask() {
    return {};
  },
};

/** The live wizard: readline prompts, plus the raw-mode settings menu. */
export function interactiveWizard(): Wizard {
  return {
    async ask(state: WizardState): Promise<InitAnswers> {
      // Interactive path: a single "mark what you want" settings menu for the
      // selection questions, then plain readline for the free-text values
      // (API keys, the OmniRoute password) that a menu cannot capture.
      if (isTuiAvailable()) {
        let result: MenuResult;
        try {
          result = await runSettingsMenu(
            partial => buildInitRows(state, partial),
            {
              title: 'e init — settings',
              instructions:
                'Space toggles a checkbox and cycles a choice · Enter finishes · q quits',
            }
          );
        } catch (err) {
          if (err instanceof MenuCancelledError) {
            // Quitting the menu is a deliberate abort, not a failure: exit
            // cleanly instead of surfacing a stack trace.
            process.exit(0);
          }
          throw err;
        }
        const answers = applyMenuResult(result, state);
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          const root = await promptRoot(rl, state.root);
          answers.root = root;
          state.root = path.resolve(root);
          answers.apiKeys = await promptApiKeys(rl, state.promptKeys);
          if (state.askOmniroutePassword) {
            const pwd = await promptOmniroutePassword(rl);
            if (pwd) answers.omniroutePassword = pwd;
          }
        } finally {
          rl.close();
        }
        return answers;
      }

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const harness = await promptFavoriteHarness(
          rl,
          state.harnessNames,
          state.currentHarness
        );
        // Runtimes come before models: the model prompt is index-aligned with
        // the union of the selected runtimes' catalogs, so the runtime answer
        // has to be resolved before the catalog can be built.
        const localRuntimes = await promptLocalRuntimes(
          rl,
          state.currentLocalRuntimes
        );
        const selectedRuntimes = resolveLocalRuntimes(
          localRuntimes,
          state.currentLocalRuntimes
        );
        const modelCatalog = composeModelCatalog(
          selectedRuntimes,
          state.runtimeCatalogs
        );
        const models = await promptModels(
          rl,
          modelCatalog,
          state.currentModels
        );
        const apiKeys = await promptApiKeys(rl, state.promptKeys);
        const omniroutePassword = state.askOmniroutePassword
          ? await promptOmniroutePassword(rl)
          : undefined;
        const gitPlatform = await promptGitPlatform(
          rl,
          state.gitPlatforms,
          state.currentGitPlatform
        );
        const shell = await promptShell(rl, state.shells);
        const root = await promptRoot(rl, state.root);

        return {
          harness,
          models,
          localRuntimes,
          apiKeys,
          ...(omniroutePassword ? { omniroutePassword } : {}),
          gitPlatform,
          root,
          shell,
        };
      } finally {
        rl.close();
      }
    },
  };
}

/** Prompts for the installation directory. */
async function promptRoot(
  rl: readline.Interface,
  current: string
): Promise<string> {
  log.info('\nInstallation directory (where `.e/` will be created):');
  for (;;) {
    const answer = await rl.question(`Choose [${current}]: `);
    const choice = answer.trim();
    if (choice === '') return current;
    const resolved = path.resolve(choice);
    return resolved;
  }
}

/** Prompts for installation directory. */
async function promptRoot(
  rl: readline.Interface,
  current: string
): Promise<string> {
  for (;;) {
    const answer = await rl.question(`Installation directory [${current}]: `);
    const choice = answer.trim();
    if (choice === '') return current;
    return path.resolve(choice);
  }
}

/** Prompts for preferred shell. */
async function promptShell(
  rl: readline.Interface,
  shells: readonly string[]
): Promise<string> {
  log.info('\nPreferred shell for completion setup:');
  shells.forEach((shell, i) => {
    log.info(`  ${i + 1}) ${shell}`);
  });
  for (;;) {
    const answer = await rl.question(`Choose [${shells[0]}]: `);
    const choice = answer.trim();
    if (choice === '') return shells[0];
    const index = parseInt(choice) - 1;
    if (index >= 0 && index < shells.length) return shells[index];
    if (shells.includes(choice)) return choice;
    log.warn(`  "${choice}" is not one of: ${shells.join(', ')}.`);
  }
}

async function promptLocalRuntimes(
  rl: readline.Interface,
  current: LocalRuntime[]
): Promise<string> {
  log.info('\nLocal AI runtimes to include:');
  LOCAL_RUNTIMES.forEach((runtime, index) => {
    log.info(
      `  [${current.includes(runtime.id) ? '*' : ' '}] ${index + 1}) ${runtime.label}`
    );
  });
  for (;;) {
    const answer = await rl.question(
      'Choose (comma-separated numbers, "all", "none", or blank to keep current): '
    );
    const valid =
      answer.trim() === '' ||
      /^(all|none|\d+(\s*,\s*\d+)*)$/i.test(answer.trim());
    if (valid) return answer;
    log.warn(`  "${answer.trim()}" is not a valid selection.`);
  }
}

/** Prompts for the favorite harness, re-asking until the answer is valid. */
async function promptFavoriteHarness(
  rl: readline.Interface,
  names: string[],
  current: string
): Promise<string> {
  log.info('\nFavorite harness (used when `e spawn` names none):');
  names.forEach((name, i) => {
    const marker = name === current ? ' (default)' : '';
    log.info(`  ${i + 1}) ${name}${marker}`);
  });
  for (;;) {
    const answer = await rl.question(`Choose [${current}]: `);
    if (parseHarnessChoice(answer, names, current)) return answer;
    log.warn(`  "${answer.trim()}" is not one of: ${names.join(', ')}.`);
  }
}

/** Prompts for which local models to provision, re-asking until the answer is valid. */
async function promptModels(
  rl: readline.Interface,
  catalog: ModelCatalogEntry[],
  current: string[]
): Promise<string | string[]> {
  if (typeof process.stdin.setRawMode === 'function') {
    return selectModels(catalog, current);
  }

  log.info(
    '\nLocal models to provision (per selected runtime; downloaded later via `e <runtime> download <model>`):'
  );
  catalog.forEach((model, i) => {
    const marker = current.includes(model.id) ? '*' : ' ';
    log.info(
      `  [${marker}] ${i + 1}) ${model.id} (${formatBytes(model.sizeBytes)})`
    );
  });
  for (;;) {
    const answer = await rl.question(
      'Choose (comma-separated numbers, "all", "none", or blank to keep current): '
    );
    if (parseModelChoice(answer, catalog, current)) return answer;
    log.warn(`  "${answer.trim()}" is not a valid selection.`);
  }
}

/** Provides a keyboard-selectable model list when init is attached to a terminal. */
async function selectModels(
  catalog: ModelCatalogEntry[],
  current: string[]
): Promise<string[]> {
  const input = process.stdin;
  const output = process.stdout;
  const selected = new Set(
    current.filter(model => catalog.some(entry => entry.id === model))
  );
  let cursor = 0;
  let renderedLines = 0;
  const allSelected = (): boolean => selected.size === catalog.length;

  const render = (): void => {
    if (renderedLines > 0) output.write(`\x1b[${renderedLines}A`);
    const lines = [
      'Local models to provision (per selected runtime; Space toggles, Enter confirms):',
      `${cursor === 0 ? '>' : ' '} [${allSelected() ? 'x' : ' '}] All models`,
      ...catalog.map((model, index) => {
        const marker = selected.has(model.id) ? 'x' : ' ';
        const pointer = index + 1 === cursor ? '>' : ' ';
        return `${pointer} [${marker}] ${index + 1}) ${model.id} (${formatBytes(model.sizeBytes)})`;
      }),
      'Use Up/Down to move, Space to select, Enter to continue.',
    ];
    output.write(lines.map(line => `\x1b[2K\r${line}`).join('\n') + '\n');
    renderedLines = lines.length;
  };

  return new Promise<string[]>((resolve, reject) => {
    const finish = (error?: Error): void => {
      input.setRawMode?.(false);
      input.removeListener('keypress', onKeypress);
      input.resume();
      output.write(`\x1b[${renderedLines}A`);
      output.write(
        Array.from(
          { length: renderedLines },
          (_, index) => `\x1b[2K\r${index === renderedLines - 1 ? '' : '\n'}`
        ).join('')
      );
      if (error) {
        reject(error);
      } else {
        output.write(
          `Selected models: ${[...selected].join(', ') || 'none'}\n`
        );
        resolve([...selected]);
      }
    };

    const onKeypress = (_: string, key: readlineSync.Key): void => {
      if (key.ctrl && key.name === 'c') {
        finish(new Error('Model selection cancelled.'));
      } else if (key.name === 'return' || key.name === 'enter') {
        finish();
      } else if (key.name === 'space') {
        if (cursor === 0) {
          if (allSelected()) selected.clear();
          else catalog.forEach(model => selected.add(model.id));
        } else {
          const model = catalog[cursor - 1].id;
          if (selected.has(model)) selected.delete(model);
          else selected.add(model);
        }
        render();
      } else if (key.name === 'up' || key.name === 'k') {
        cursor = (cursor + catalog.length) % (catalog.length + 1);
        render();
      } else if (key.name === 'down' || key.name === 'j') {
        cursor = (cursor + 1) % (catalog.length + 1);
        render();
      }
    };

    input.pause();
    readlineSync.emitKeypressEvents(input);
    input.setRawMode?.(true);
    render();
    setImmediate(() => {
      // The previous readline.question can leave its Enter in the input buffer.
      // Discard it before this selector begins handling keypresses.
      while (input.read() !== null) {
        // Drain buffered input.
      }
      input.on('keypress', onKeypress);
      input.resume();
    });
  });
}

/** Prompts for each API key; a blank answer leaves that key unset in `.env`. */
async function promptApiKeys(
  rl: readline.Interface,
  keys: string[]
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  if (keys.length === 0) return values;
  log.info('\nAPI keys (leave blank to skip; edit `.e/.env` later):');
  for (const key of keys) {
    const answer = (await rl.question(`  ${key}: `)).trim();
    if (answer) values[key] = answer;
  }
  return values;
}

/**
 * Prompts for the OmniRoute dashboard sign-in password (asked only when the
 * store env has none). A blank answer means "generate a random one": the
 * answer is omitted, and planInit's seeder fills a fresh random value.
 */
async function promptOmniroutePassword(
  rl: readline.Interface
): Promise<string> {
  log.info(
    '\nOmniRoute dashboard sign-in password (used at http://localhost:20128; a blank answer generates a random one):'
  );
  return (await rl.question('  Initial password: ')).trim();
}

/** Prompts for the git platform, re-asking until the answer is valid. */
async function promptGitPlatform(
  rl: readline.Interface,
  platforms: string[],
  current?: string
): Promise<string> {
  log.info(
    '\nGit platform (creates a PR/MR on a successful run; blank disables):'
  );
  platforms.forEach((name, i) => {
    const marker = name === current ? ' (current)' : '';
    log.info(`  ${i + 1}) ${name}${marker}`);
  });
  for (;;) {
    const answer = await rl.question(
      current
        ? `Choose [${current} or blank to disable]: `
        : `Choose [blank to disable]: `
    );
    // A blank answer always disables PR/MR creation (even on a first init);
    // anything else must resolve to a known platform.
    if (
      answer.trim() === '' ||
      parseGitPlatformChoice(answer, platforms) !== undefined
    ) {
      return answer;
    }
    log.warn(`  "${answer.trim()}" is not one of: ${platforms.join(', ')}.`);
  }
}
