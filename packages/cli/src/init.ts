import fs from 'fs';
import path from 'path';
import * as readline from 'node:readline/promises';
import * as readlineSync from 'node:readline';
import { setImmediate } from 'node:timers';
import type { Command } from 'commander';
import { renderDockerfile } from './harness/renderDockerfile';
import { renderEnvTemplate } from './harness/renderEnvTemplate';
import { renderCompose } from './renderCompose';
import { renderBootstrap } from './renderBootstrap';
import { detectHardware, llamaCppImage } from './hardware/index';
import { writeIfAbsent } from './scaffold';
import {
  HARNESSES,
  type Harness,
  envHarnessSections,
  requiredEnvKeys,
} from './harness/index';
import { renderDefaultAgent } from './agent';
import { parseDotenv } from './harness/adapter';
import { SHIPPED_MCP_SERVERS } from './mcp/index';
import { SHIPPED_SKILLS, SHIPPED_SKILL_COLLECTIONS } from './skill/index';
import {
  MODEL_CATALOG,
  formatBytes,
  type ModelCatalogEntry,
} from './modelStatus';
import {
  dockerfilePath,
  dockerComposePath,
  bootstrapScriptPath,
  harnessDir,
  harnessesBaseDir,
  envFilePath,
  agentDir,
  agentFilePath,
  mcpDir,
  skillDir,
  writeConfig,
  readConfig,
} from './store';
import { log } from './utils/log';

interface InitCommandOptions {
  dir?: string;
  /** `--yes`: skip prompts and use defaults (non-interactive/CI). */
  yes?: boolean;
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description(
      'Write the harness Dockerfiles so `spawn` can build their images'
    )
    .option(
      '--dir <path>',
      'root directory to write the harnesses into (default: home directory)'
    )
    .option(
      '-y, --yes',
      'skip prompts and use defaults (non-interactive/CI)',
      false
    )
    .action(async (opts: InitCommandOptions) => {
      const root = opts.dir ? path.resolve(opts.dir) : undefined;

      // Prompt only when we can: an explicit --yes, or a non-TTY stdin/stdout
      // (a pipe or CI), falls back to defaults so the command never hangs.
      const interactive =
        !opts.yes &&
        Boolean(process.stdin.isTTY) &&
        Boolean(process.stdout.isTTY);

      // Seed from any existing config so a re-init preserves the configured
      // favorite instead of silently resetting it — mirrors how the `.env` and
      // Dockerfiles are never clobbered. A fresh store reads back the default.
      let defaultHarness = readConfig(root).defaultHarness;
      let selectedModels = readConfig(root).models;

      const envFile = envFilePath(root);
      const existingEnv = fs.existsSync(envFile)
        ? fs.readFileSync(envFile, 'utf8')
        : undefined;
      let envValues: Record<string, string> = existingEnv
        ? parseDotenv(existingEnv)
        : {};

      if (interactive) {
        // Only prompt for keys not already set in `.e/.env`; a re-init never
        // re-asks for one the user has filled in (and which `applyEnvValues`
        // would refuse to clobber anyway).

        const answers = await promptInit(
          Object.keys(HARNESSES),
          defaultHarness,
          keysToPrompt(requiredEnvKeys(), envValues),
          MODEL_CATALOG,
          selectedModels
        );
        defaultHarness = answers.defaultHarness;
        envValues = { ...envValues, ...answers.envValues };
        selectedModels = answers.models;
      }

      for (const harness of Object.values(HARNESSES)) {
        log.info('');
        log.info(`writing files for harness [${harness.name}]`);
        writeDockerfile(harness, root);
        writeDefaultAgents(harness, root, envValues);
      }

      writeMcpServers(root);
      writeSkills(root);
      const hardware = detectHardware();
      fs.mkdirSync(path.dirname(bootstrapScriptPath(root)), {
        recursive: true,
      });
      fs.writeFileSync(
        bootstrapScriptPath(root),
        renderBootstrap(selectedModels)
      );
      prepareComposeDataDir(root);
      writeIfAbsent(
        path.dirname(dockerComposePath(root)),
        dockerComposePath(root),
        renderCompose(hardware)
      );
      log.info(
        `Detected hardware: ${hardware} -> using ${llamaCppImage(hardware)} for the local llama.cpp provider.`
      );

      writeEnvFile(root, envValues);
      writeConfig({ defaultHarness, models: selectedModels }, root);
      log.info(`favorite harness: ${defaultHarness}`);
      log.info(`local models: ${selectedModels.join(', ')}`);

      log.success(
        `\nInitialized ${Object.keys(HARNESSES).length} harnesses in ${harnessesBaseDir(root)}.`
      );
      log.info(
        `Container MCP servers ready: ${Object.keys(SHIPPED_MCP_SERVERS).join(', ')} (compose with \`--mcp <name>\`).`
      );
      log.info(
        `Skills ready: ${Object.keys(SHIPPED_SKILLS).join(', ')} (add with \`--skill <name>\` or bake into an agent); collections ${SHIPPED_SKILL_COLLECTIONS.join(', ')} install into every harness image at build time.`
      );
      log.info(
        'Run `e spawn "<prompt>"` to run your favorite harness, or `e spawn <harness> "<prompt>"` to pick one.'
      );
    });
}

/**
 * Runs the interactive `e init` flow: asks for the favorite harness (defaulting
 * to `current`, preselected), which local models to provision (multi-select,
 * `current` preselected), and for each API key in `apiKeys` (already-set keys
 * are filtered out by the caller). Owns the readline lifecycle so the callers
 * stay effect-free.
 */
async function promptInit(
  harnessNames: string[],
  current: string,
  envKeys: string[],
  modelCatalog: ModelCatalogEntry[],
  currentModels: string[]
): Promise<{
  defaultHarness: string;
  envValues: Record<string, string>;
  models: string[];
}> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const defaultHarness = await promptFavoriteHarness(
      rl,
      harnessNames,
      current
    );
    const models = await promptModels(rl, modelCatalog, currentModels);
    const envValues = await promptApiKeys(rl, envKeys);
    return { defaultHarness, envValues, models };
  } finally {
    rl.close();
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
    const choice = parseHarnessChoice(answer, names, current);
    if (choice) return choice;
    log.warn(`  "${answer.trim()}" is not one of: ${names.join(', ')}.`);
  }
}

/** Prompts for which local models to provision, re-asking until the answer is valid. */
async function promptModels(
  rl: readline.Interface,
  catalog: ModelCatalogEntry[],
  current: string[]
): Promise<string[]> {
  if (typeof process.stdin.setRawMode === 'function') {
    return selectModels(catalog, current);
  }

  log.info('\nLocal models to download (used by `e spawn` via llama.cpp):');
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
    const choice = parseModelChoice(answer, catalog, current);
    if (choice) return choice;
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
      'Local models to download (Space toggles, Enter confirms):',
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
 * Resolves a favorite-harness prompt answer, purely: a blank answer takes the
 * `fallback`, an exact name or a 1-based list index selects that harness, and
 * anything else is unrecognized (`undefined`, so the glue re-prompts).
 */
export function parseHarnessChoice(
  input: string,
  names: string[],
  fallback: string
): string | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return fallback;
  if (names.includes(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) {
    const idx = Number(trimmed) - 1;
    if (idx >= 0 && idx < names.length) return names[idx];
  }
  return undefined;
}

/**
 * Resolves a model multi-select prompt answer, purely: a blank answer keeps
 * `fallback`, `"all"`/`"none"` select every/no catalog entry, and a
 * comma-separated list of 1-based indices selects those models (deduplicated).
 * Anything else — an unknown token, an out-of-range index — is unrecognized
 * (`undefined`, so the glue re-prompts).
 */
export function parseModelChoice(
  input: string,
  catalog: ModelCatalogEntry[],
  fallback: string[]
): string[] | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return fallback;
  if (trimmed.toLowerCase() === 'all') return catalog.map(m => m.id);
  if (trimmed.toLowerCase() === 'none') return [];

  const parts = trimmed
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;

  const ids = new Set<string>();
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    const idx = Number(part) - 1;
    if (idx < 0 || idx >= catalog.length) return undefined;
    ids.add(catalog[idx].id);
  }
  return [...ids];
}

/**
 * The API keys `e init` should still prompt for, purely: the `required` keys
 * minus any already set to a non-blank value in the existing `.env` content.
 * A missing file (`undefined`) or a key present but blank (`KEY=`) still
 * prompts; a filled key is skipped so a re-init never re-asks for it.
 */
export function keysToPrompt(
  required: string[],
  existingEnv: Record<string, string> | undefined
): string[] {
  if (existingEnv === undefined) {
    return required;
  }
  return required.filter(key => (existingEnv[key] ?? '').trim() === '');
}

/**
 * Fills collected values into a `.env` body, purely: a line that is exactly
 * `KEY=` (blank) becomes `KEY=<value>` when a non-empty value was collected for
 * it. Already-filled keys and keys with no collected value are left untouched,
 * so re-running `init` never clobbers a hand-edited `.env`.
 */
export function applyEnvValues(
  content: string,
  values: Record<string, string>
): string {
  return content
    .split('\n')
    .map(line => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=$/.exec(line);
      if (!match) return line;
      const value = values[match[1]];
      return value ? `${match[1]}=${value}` : line;
    })
    .join('\n');
}

/** Creates local Compose volume directories with container-writable permissions. */
export function prepareComposeDataDir(root?: string): void {
  const volumesDir = path.join(
    path.dirname(dockerComposePath(root)),
    'volumes'
  );
  for (const name of ['omniroute-data', 'llama-data', 'redis-data']) {
    const directory = path.join(volumesDir, name);
    fs.mkdirSync(directory, { recursive: true });
    fs.chmodSync(directory, 0o777);
  }
}

/**
 * Writes a harness's Dockerfile (never overwriting a hand-edited one). The
 * harness's own dockerfile params carry its skill collections and the skills
 * CLI agent name; the rendered Dockerfile installs each collection at build
 * time (`npx skills@latest add … -a <agent> -g -y --copy`) into the skills
 * dir the harness CLI reads, outside `/workspace` (ADR-0006 layer 1).
 */
function writeDockerfile(harness: Harness, root: string | undefined): void {
  writeIfAbsent(
    harnessDir(harness.name, root),
    dockerfilePath(harness.name, root),
    renderDockerfile(harness.dockerfile)
  );
}

/** Writes a harness's default agent definition (never overwriting a hand-edited one). */
function writeDefaultAgents(
  harness: Harness,
  root: string | undefined,
  envValues: Record<string, string>
): void {
  writeIfAbsent(
    agentDir(harness.name, root),
    agentFilePath(harness.name, root),
    renderDefaultAgent(harness.name, envValues)
  );
}

/**
 * Writes the shipped container MCP servers under `.e/mcp/<name>/` (Dockerfile +
 * mcp.json), never overwriting a hand-edited file. These are ready to compose as
 * sidecars with `e spawn <claude-agent> --mcp <name> "…"` (ADR-0005).
 */
function writeMcpServers(root: string | undefined): void {
  for (const [name, render] of Object.entries(SHIPPED_MCP_SERVERS)) {
    const dir = mcpDir(name, root);
    const files = render();
    for (const [fileName, content] of Object.entries(files)) {
      writeIfAbsent(dir, path.join(dir, fileName), content);
    }
  }
}

/**
 * Writes the shipped Skills under `.e/skills/<name>/` (a `SKILL.md` plus any
 * resources), never overwriting a hand-edited file. These can be baked into an
 * agent (agent.json `skills`) or added per-run with `e spawn … --skill <name>`.
 */
function writeSkills(root: string | undefined): void {
  for (const [name, render] of Object.entries(SHIPPED_SKILLS)) {
    const dir = skillDir(name, root);
    const files = render();
    for (const [relPath, content] of Object.entries(files)) {
      const file = path.join(dir, relPath);
      writeIfAbsent(path.dirname(file), file, content);
    }
  }
}

/**
 * Writes the shared `.env` base environment file, seeding any interactively
 * collected `values`. When absent it is created from the template; when it
 * already exists, sections for harnesses not yet present are appended so the
 * user's filled-in values are preserved. Collected values fill blank `KEY=`
 * lines only (see {@link applyEnvValues}).
 */
function writeEnvFile(
  root: string | undefined,
  values: Record<string, string> = {}
): void {
  const file = envFilePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const sections = envHarnessSections();
  const existing = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8')
    : undefined;

  let content: string;
  if (existing === undefined) {
    content = renderEnvTemplate({ harnesses: sections });
  } else {
    const missing = sections.filter(
      section => !existing.includes(`# --- ${section.name} ---`)
    );
    if (missing.length === 0) {
      content = existing;
    } else {
      const separator = existing.endsWith('\n') ? '\n' : '\n\n';
      content =
        existing +
        separator +
        renderEnvTemplate({ harnesses: missing, includeHeader: false });
    }
  }

  content = applyEnvValues(content, values);

  if (existing === undefined) {
    fs.writeFileSync(file, content);
    log.success(`wrote ${file}`);
  } else if (content === existing) {
    log.info(`up to date ${file}`);
  } else {
    fs.writeFileSync(file, content);
    log.success(`updated ${file}`);
  }
}
