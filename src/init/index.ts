import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import { detectHardware, llamaCppImage } from '../hardware/index.js';
import { writeIfAbsent } from '../scaffold.js';
import { HARNESSES, requiredEnvKeys } from '../harness/index.js';
import { parseDotenv } from '../utils/dotenv.js';
import { SHIPPED_MCP_SERVERS } from '../mcp/index.js';
import { SHIPPED_SKILLS, SHIPPED_SKILL_COLLECTIONS } from '../skill/index.js';
import { envFilePath, harnessesBaseDir } from '../store/paths.js';
import { GIT_PLATFORMS, readConfig, writeConfig } from '../store/config.js';
import { log } from '../utils/log.js';
import {
  keysToPrompt,
  planInit,
  type InitPlan,
  type InitState,
  type InitWrite,
} from './initPlan.js';
import { defaultsWizard, interactiveWizard, type Wizard } from './wizard.js';
import { RUNTIME_CATALOGS } from './localRuntimes.js';
import { completionSourceCommand, ensureShellRcEntry } from './shellRc.js';

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
    !opts.yes && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

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
    currentLocalRuntimes: config.localRuntimes,
    existingEnvContent,
    runtimeCatalogs: RUNTIME_CATALOGS,
    gitPlatforms: [...GIT_PLATFORMS],
    currentGitPlatform: config.gitPlatform,
    hardware: detectHardware(),
  };

  log.info(
    `init interactive=${interactive} stdinTTY=${process.stdin.isTTY} stdoutTTY=${process.stdout.isTTY}`
  );

  // Only prompt for keys not already set in `.e/.env`; a re-init never re-asks
  // for one the user has filled in (and which `applyEnvValues` would refuse to
  // clobber anyway).
  const wizard: Wizard = interactive ? interactiveWizard() : defaultsWizard;
  const answers = await wizard.ask({
    harnessNames: state.harnessNames,
    currentHarness: state.currentDefaultHarness,
    promptKeys: keysToPrompt(requiredEnvKeys(), existingValues),
    // Ask for the OmniRoute sign-in password only when the store env has none;
    // an already-set password is never re-asked and never rotated.
    askOmniroutePassword:
      (existingValues.OMNIROUTE_INITIAL_PASSWORD ?? '').trim() === '',
    runtimeCatalogs: RUNTIME_CATALOGS,
    currentModels: state.currentModels,
    currentLocalRuntimes: state.currentLocalRuntimes,
    gitPlatforms: state.gitPlatforms,
    currentGitPlatform: config.gitPlatform,
    shells: ['bash', 'zsh', 'fish', 'powershell'],
  });

  applyPlan(root, planInit(state, answers), answers.shell);
}

/** Applies an {@link InitPlan} to disk — the only layer that touches the filesystem. */
function applyPlan(
  root: string | undefined,
  plan: InitPlan,
  shell?: string
): void {
  for (const step of plan.steps) {
    log.info('');
    if (step.kind === 'harness') {
      log.info(`writing files for harness [${step.name}]`);
      for (const write of step.writes) {
        applyWrite(write);
      }
    } else if (step.kind === 'bootstrap') {
      log.info(`writing files for bootstrap configuration`);
      applyWrite(step.write);
    } else if (step.kind === 'compose') {
      log.info(`writing files for compose configuration`);
      applyWrite(step.write);
    } else {
      for (const write of step.writes) {
        applyWrite(write);
      }
    }
  }

  if (plan.localRuntimes.includes('llamacpp')) {
    log.info(
      `Detected hardware: ${plan.hardware} -> using ${llamaCppImage(plan.hardware)} for local llama.cpp.`
    );
  } else {
    log.info('Local AI runtime: none selected.');
  }

  writeEnv(plan.env);
  writeConfig(plan.config, root);
  log.info(`favorite harness: ${plan.defaultHarness}`);
  log.info(`local models: ${plan.models.join(', ')}`);
  log.info(
    plan.gitPlatform
      ? `PR/MR platform: ${plan.gitPlatform} (created on successful runs)`
      : 'PR/MR platform: disabled (run `e init` to enable)'
  );

  log.success(
    `\nInitialized ${Object.keys(HARNESSES).length} harnesses in ${harnessesBaseDir(root)}.`
  );
  log.info(
    `Container MCP servers ready: ${Object.keys(SHIPPED_MCP_SERVERS).join(', ')} (compose with \`--mcp <name>\`).`
  );
  log.info(
    `Skills ready: ${Object.keys(SHIPPED_SKILLS).join(', ')} (add with \`--skill <name>\` or bake into an agent); collections ${SHIPPED_SKILL_COLLECTIONS.join(', ')} install into every harness image at build time.`
  );
  log.info('\n\n');
  log.info('\n--- Next Steps ---');
  log.info('1. Enable shell completions:');
  // A shell answer only comes from the wizard when the user actually went
  // through the interactive prompt, so this never touches a rc file during
  // `--yes`/non-interactive runs (e.g. CI).
  const rcResult = shell !== undefined ? ensureShellRcEntry(shell) : undefined;
  if (rcResult?.status === 'added') {
    log.success(`   added completion setup to ${rcResult.file}`);
    log.command(`   # Restart your shell, or: source ${rcResult.file}`);
  } else if (rcResult?.status === 'already-configured') {
    log.info(`   already configured in ${rcResult.file}`);
  } else {
    log.command(`   # Add to ~/.${shell ?? 'bash'}rc or similar`);
    log.command(`   ${completionSourceCommand(shell ?? 'bash')}`);
  }
  log.info('\n2. Run your favorite harness:');
  log.command('   e spawn "<prompt>"');
  log.info('\n3. Explore more commands:');
  log.command('   e --help');
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
