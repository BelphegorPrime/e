import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import { detectHardware, llamaCppImage } from '../hardware/index';
import { writeIfAbsent } from '../scaffold';
import { HARNESSES, requiredEnvKeys } from '../harness/index';
import { parseDotenv } from '../harness/adapter';
import { SHIPPED_MCP_SERVERS } from '../mcp/index';
import { SHIPPED_SKILLS, SHIPPED_SKILL_COLLECTIONS } from '../skill/index';
import { MODEL_CATALOG } from '../modelStatus';
import {
  dockerComposePath,
  envFilePath,
  harnessesBaseDir,
} from '../store/paths';
import { readConfig, writeConfig } from '../store/config';
import { log } from '../utils/log';
import {
  keysToPrompt,
  planInit,
  type InitPlan,
  type InitState,
  type InitWrite,
} from './initPlan';
import { defaultsWizard, interactiveWizard, type Wizard } from './wizard';

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
      await runInit(opts);
    });
}

/**
 * Runs a full `e init`. This is the thin executor: it gathers the on-disk
 * state, picks a wizard, collects answers, and applies the resulting
 * {@link InitPlan}. Every decision — what gets written, in what order, and
 * what never gets clobbered — lives in `planInit` (pure, fully tested), so the
 * interactive flow, `--yes`, and a piped/CI run all share one tested core.
 */
async function runInit(opts: InitCommandOptions): Promise<void> {
  const root = opts.dir ? path.resolve(opts.dir) : undefined;

  // Ask only when there is a terminal to ask on: `--yes`, or a non-TTY
  // stdin/stdout (a pipe or CI), falls back to defaults so the command never
  // hangs.
  const interactive =
    !opts.yes &&
    Boolean(process.stdin.isTTY) &&
    Boolean(process.stdout.isTTY);

  // Seed from any existing config so a re-init preserves the configured
  // favorite instead of silently resetting it — mirrors how the `.env` and
  // Dockerfiles are never clobbered. A fresh store reads back the default.
  const config = readConfig(root);
  const envFile = envFilePath(root);
  const existingEnvContent = fs.existsSync(envFile)
    ? fs.readFileSync(envFile, 'utf8')
    : undefined;
  const existingValues = existingEnvContent
    ? parseDotenv(existingEnvContent)
    : {};

  const state: InitState = {
    root,
    harnessNames: Object.keys(HARNESSES),
    currentDefaultHarness: config.defaultHarness,
    currentModels: config.models,
    existingEnvContent,
    modelCatalog: MODEL_CATALOG,
    hardware: detectHardware(),
  };

  // Only prompt for keys not already set in `.e/.env`; a re-init never re-asks
  // for one the user has filled in (and which `applyEnvValues` would refuse to
  // clobber anyway).
  const wizard: Wizard = interactive ? interactiveWizard() : defaultsWizard;
  const answers = await wizard.ask({
    harnessNames: state.harnessNames,
    currentHarness: state.currentDefaultHarness,
    promptKeys: keysToPrompt(requiredEnvKeys(), existingValues),
    modelCatalog: state.modelCatalog,
    currentModels: state.currentModels,
  });

  applyPlan(root, planInit(state, answers));
}

/** Applies an {@link InitPlan} to disk — the only layer that touches the filesystem. */
function applyPlan(root: string | undefined, plan: InitPlan): void {
  for (const step of plan.steps) {
    if (step.kind === 'harness') {
      log.info('');
      log.info(`writing files for harness [${step.name}]`);
      for (const write of step.writes) applyWrite(write);
    } else if (step.kind === 'bootstrap') {
      applyWrite(step.write);
    } else if (step.kind === 'compose') {
      // Local Compose volume dirs are prepared just before the compose file,
      // matching the historic write order.
      prepareComposeDataDir(root);
      applyWrite(step.write);
    } else {
      for (const write of step.writes) applyWrite(write);
    }
  }

  log.info(
    `Detected hardware: ${plan.hardware} -> using ${llamaCppImage(plan.hardware)} for the local llama.cpp provider.`
  );

  writeEnv(plan.env);
  writeConfig(plan.config, root);
  log.info(`favorite harness: ${plan.defaultHarness}`);
  log.info(`local models: ${plan.models.join(', ')}`);

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
}

/** One filesystem write: mkdir the parent, then write honoring the clobber rule. */
function applyWrite(write: InitWrite): void {
  if (write.clobber === 'never') {
    writeIfAbsent(write.directory, write.file, write.content);
  } else {
    fs.mkdirSync(write.directory, { recursive: true });
    fs.writeFileSync(write.file, write.content);
  }
}

/** Writes the planned `.env` body, reporting wrote/updated/up-to-date as before. */
function writeEnv(env: InitPlan['env']): void {
  fs.mkdirSync(path.dirname(env.file), { recursive: true });
  if (env.created) {
    fs.writeFileSync(env.file, env.content);
    log.success(`wrote ${env.file}`);
  } else if (env.changed) {
    fs.writeFileSync(env.file, env.content);
    log.success(`updated ${env.file}`);
  } else {
    log.info(`up to date ${env.file}`);
  }
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