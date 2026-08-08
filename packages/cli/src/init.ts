import fs from 'fs';
import path from 'path';
import * as readline from 'node:readline/promises';
import type { Command } from 'commander';
import { renderDockerfile } from './harness/renderDockerfile';
import { renderEnvTemplate } from './harness/renderEnvTemplate';
import { writeIfAbsent } from './scaffold';
import {
  HARNESSES,
  type Harness,
  envHarnessSections,
  requiredEnvKeys,
} from './harness/index';
import { renderDefaultAgent } from './agent';
import { SHIPPED_MCP_SERVERS } from './mcp/index';
import { SHIPPED_SKILLS } from './skill/index';
import {
  dockerfilePath,
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

interface InitCommandOptions {
  dir?: string;
  /** `--yes`: skip prompts and use defaults (non-interactive/CI). */
  yes?: boolean;
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description(
      'Write the harness Dockerfiles so `spawn` can build their images',
    )
    .option(
      '--dir <path>',
      'root directory to write the harnesses into (default: home directory)',
    )
    .option(
      '-y, --yes',
      'skip prompts and use defaults (non-interactive/CI)',
      false,
    )
    .action(async (opts: InitCommandOptions) => {
      const root = opts.dir ? path.resolve(opts.dir) : undefined;

      // Prompt only when we can: an explicit --yes, or a non-TTY stdin/stdout
      // (a pipe or CI), falls back to defaults so the command never hangs.
      const interactive =
        !opts.yes && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

      // Seed from any existing config so a re-init preserves the configured
      // favorite instead of silently resetting it — mirrors how the `.env` and
      // Dockerfiles are never clobbered. A fresh store reads back the default.
      let defaultHarness = readConfig(root).defaultHarness;
      let envValues: Record<string, string> = {};
      if (interactive) {
        const answers = await promptInit(Object.keys(HARNESSES), defaultHarness);
        defaultHarness = answers.defaultHarness;
        envValues = answers.envValues;
      }

      for (const harness of Object.values(HARNESSES)) {
        writeDockerfile(harness, root);
        writeDefaultAgent(harness, root);
      }

      writeMcpServers(root);
      writeSkills(root);

      writeEnvFile(root, envValues);
      writeConfig({ defaultHarness }, root);
      console.log(`favorite harness: ${defaultHarness}`);

      console.log(
        `\nInitialized ${Object.keys(HARNESSES).length} harnesses in ${harnessesBaseDir(root)}.`,
      );
      console.log(
        `Container MCP servers ready: ${Object.keys(SHIPPED_MCP_SERVERS).join(', ')} (compose with \`--mcp <name>\`).`,
      );
      console.log(
        `Skills ready: ${Object.keys(SHIPPED_SKILLS).join(', ')} (add with \`--skill <name>\` or bake into an agent).`,
      );
      console.log(
        'Run `e spawn "<prompt>"` to run your favorite harness, or `e spawn <harness> "<prompt>"` to pick one.',
      );
    });
}

/**
 * Runs the interactive `e init` flow: asks for the favorite harness (defaulting
 * to `current`, preselected) and for each required API key. Owns the readline
 * lifecycle so the callers stay effect-free.
 */
async function promptInit(
  harnessNames: string[],
  current: string,
): Promise<{
  defaultHarness: string;
  envValues: Record<string, string>;
}> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const defaultHarness = await promptFavoriteHarness(rl, harnessNames, current);
    const envValues = await promptApiKeys(rl, requiredEnvKeys());
    return { defaultHarness, envValues };
  } finally {
    rl.close();
  }
}

/** Prompts for the favorite harness, re-asking until the answer is valid. */
async function promptFavoriteHarness(
  rl: readline.Interface,
  names: string[],
  current: string,
): Promise<string> {
  console.log('\nFavorite harness (used when `e spawn` names none):');
  names.forEach((name, i) => {
    const marker = name === current ? ' (default)' : '';
    console.log(`  ${i + 1}) ${name}${marker}`);
  });
  for (;;) {
    const answer = await rl.question(`Choose [${current}]: `);
    const choice = parseHarnessChoice(answer, names, current);
    if (choice) return choice;
    console.log(`  "${answer.trim()}" is not one of: ${names.join(', ')}.`);
  }
}

/** Prompts for each API key; a blank answer leaves that key unset in `.env`. */
async function promptApiKeys(
  rl: readline.Interface,
  keys: string[],
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  if (keys.length === 0) return values;
  console.log('\nAPI keys (leave blank to skip; edit `.e/.env` later):');
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
  fallback: string,
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
 * Fills collected values into a `.env` body, purely: a line that is exactly
 * `KEY=` (blank) becomes `KEY=<value>` when a non-empty value was collected for
 * it. Already-filled keys and keys with no collected value are left untouched,
 * so re-running `init` never clobbers a hand-edited `.env`.
 */
export function applyEnvValues(
  content: string,
  values: Record<string, string>,
): string {
  return content
    .split('\n')
    .map((line) => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=$/.exec(line);
      if (!match) return line;
      const value = values[match[1]];
      return value ? `${match[1]}=${value}` : line;
    })
    .join('\n');
}

/** Writes a harness's Dockerfile (never overwriting a hand-edited one). */
function writeDockerfile(harness: Harness, root: string | undefined): void {
  writeIfAbsent(
    harnessDir(harness.name, root),
    dockerfilePath(harness.name, root),
    renderDockerfile(harness.dockerfile),
  );
}

/** Writes a harness's default agent definition (never overwriting a hand-edited one). */
function writeDefaultAgent(harness: Harness, root: string | undefined): void {
  writeIfAbsent(
    agentDir(harness.name, root),
    agentFilePath(harness.name, root),
    renderDefaultAgent(harness.name),
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
  values: Record<string, string> = {},
): void {
  const file = envFilePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const sections = envHarnessSections();
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;

  let content: string;
  if (existing === undefined) {
    content = renderEnvTemplate({ harnesses: sections });
  } else {
    const missing = sections.filter(
      (section) => !existing.includes(`# --- ${section.name} ---`),
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
    console.log(`wrote ${file}`);
  } else if (content === existing) {
    console.log(`up to date ${file}`);
  } else {
    fs.writeFileSync(file, content);
    console.log(`updated ${file}`);
  }
}
