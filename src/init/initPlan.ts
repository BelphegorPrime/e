import path from 'path';
import { randomBytes } from 'node:crypto';
import { renderDockerfile } from '../harness/renderDockerfile.js';
import { renderEnvTemplate } from '../harness/renderEnvTemplate.js';
import { renderCompose } from './renderCompose.js';
import { renderBootstrap } from './renderBootstrap.js';
import { renderEgressFiles } from './renderEgress.js';
import { HARNESSES, envHarnessSections } from '../harness/index.js';
import { renderDefaultAgent } from '../agent/index.js';
import { parseDotenv } from '../harness/adapter.js';
import { STACK_NETWORK } from '../constants.js';
import { SHIPPED_MCP_SERVERS } from '../mcp/index.js';
import { SHIPPED_SKILLS } from '../skill/index.js';
import type { HardwareVendor } from '../hardware/index.js';
import type { ModelCatalogEntry } from '../modelStatus.js';
import type { GitPlatform } from '../store/config.js';
import {
  LOCAL_RUNTIMES,
  composeModelCatalog,
  type LocalRuntime,
} from './localRuntimes.js';
import {
  agentDir,
  agentFilePath,
  bootstrapScriptPath,
  dockerComposePath,
  dockerfilePath,
  egressBlacklistPath,
  egressDir,
  envFilePath,
  harnessDir,
  mcpDir,
  skillDir,
} from '../store/paths.js';

/**
 * The OmniRoute stack secrets the local Compose stack interpolates from
 * `.e/.env` (see `renderCompose`). No fallbacks exist in the template, so an
 * unseeded variable makes the stack unusable rather than known-default;
 * `e init` seeds these with fresh random values.
 */
export const OMNIROUTE_STACK_SECRETS = [
  'OMNIROUTE_INITIAL_PASSWORD',
  'JWT_SECRET',
  'API_KEY_SECRET',
] as const;

/** Seeder for each stack secret (caller picks the fresh random value). */
const STACK_SECRET_GENERATORS: ReadonlyArray<readonly [string, () => string]> =
  [
    ['OMNIROUTE_INITIAL_PASSWORD', () => randomBytes(16).toString('hex')],
    ['JWT_SECRET', () => randomBytes(32).toString('hex')],
    ['API_KEY_SECRET', () => randomBytes(32).toString('hex')],
  ];

/**
 * Generates fresh random values for the OmniRoute stack secrets, purely: a key
 * already set to a non-blank value keeps its value, so a re-init never rotates
 * a password or secret the user already configured (or a previous init
 * generated). Only unset/blank keys get a random value.
 */
export function seedStackSecrets(
  env: Record<string, string>
): Record<string, string> {
  const seeded: Record<string, string> = {};
  for (const [key, generate] of STACK_SECRET_GENERATORS) {
    const current = (env[key] ?? '').trim();
    seeded[key] = current !== '' ? current : generate();
  }
  return seeded;
}

/** Everything the planner knows about the disk before answering a wizard. */
export interface InitState {
  /** The directory to initialize into (the home directory when undefined). */
  root?: string;
  /** Favorite-harness names in prompt order. */
  harnessNames: string[];
  /** The configured favorite, kept when the user answers blank. */
  currentDefaultHarness: string;
  /** The configured model selection, kept when the user answers blank. */
  currentModels: string[];
  /** Configured local runtime selection, kept when the wizard answer is blank. */
  currentLocalRuntimes: LocalRuntime[];
  /** Existing `.e/.env` raw content, if any (a missing file prompts for every key). */
  existingEnvContent?: string;
  /** Per-runtime model catalogs; the plan shows the union of the selected runtimes'. */
  runtimeCatalogs: Readonly<Record<LocalRuntime, readonly ModelCatalogEntry[]>>;
  /** All git platforms offered by this init, in prompt order. */
  gitPlatforms: GitPlatform[];
  /** The configured git platform, kept when a re-init doesn't change it (`--yes`). */
  currentGitPlatform?: GitPlatform;
  /** Detected GPU vendor (resolved by the executor, so planning stays pure). */
  hardware: HardwareVendor;
}

/** Raw wizard answers; the planner resolves blanks and keeps configured values. */
export interface InitAnswers {
  /** A 1-based index, an exact harness name, or ''/undefined to keep the current favorite. */
  harness?: string;
  /** Raw selection text ('', 'all', 'none', '1,3') or a pre-resolved id list from the raw-mode selector. */
  models?: string | string[];
  /** Raw runtime selection text or ids from a keyboard selector. */
  localRuntimes?: string | LocalRuntime[];
  /** Collected API-key values to fill into blank `.env` lines (blank answers omitted). */
  apiKeys?: Record<string, string>;
  /**
   * The OmniRoute dashboard sign-in password, when the interactive wizard
   * asked for one. Blank (or undefined) leaves the key unset, so planInit's
   * seeder generates a fresh random value — user input wins over random only
   * when the user actually typed one.
   */
  omniroutePassword?: string;
  /** A 1-based index, an exact platform name, or ''/undefined (blank disables PR/MR). */
  gitPlatform?: string;
  /** Preferred shell for completion setup (e.g. 'bash', 'zsh', 'fish'). */
  shell?: string;
}

/** One filesystem write the plan prescribes, in prescribed order. */
export interface InitWrite {
  /** Directory to create (recursively) before writing; parent of {@link file}. */
  directory: string;
  /** Absolute path of the file to write. */
  file: string;
  /** Rendered content. */
  content: string;
  /**
   * `never` — a `writeIfAbsent` (never clobber a hand edit, show a diff);
   * `always` — an unconditional overwrite (bootstrap script, config).
   */
  clobber: 'never' | 'always';
}

/** An ordered build step; harness steps log a banner, plain batches log per write. */
export type InitStep =
  | { kind: 'harness'; name: string; writes: InitWrite[] }
  | { kind: 'writes'; writes: InitWrite[] }
  | { kind: 'bootstrap'; write: InitWrite }
  | { kind: 'compose'; write: InitWrite };

/** The full, ordered description of what `e init` will do — pure and testable. */
export interface InitPlan {
  /** Ordered build steps (harness files, shipped MCP/skills, bootstrap, compose). */
  steps: InitStep[];
  /** The final `.env` write outcome (body, and how it differs from disk). */
  env: {
    file: string;
    content: string;
    /** No `.env` existed before: the file is created. */
    created: boolean;
    /** The file existed and its body changed: the file is rewritten. */
    changed: boolean;
  };
  /** The config.json payload the init records (overwrite semantics). */
  config: {
    defaultHarness: string;
    models: string[];
    localRuntimes: LocalRuntime[];
    gitPlatform?: GitPlatform;
  };
  /** Resolved choices (post-answers; blank keeps the configured current). */
  defaultHarness: string;
  models: string[];
  localRuntimes: LocalRuntime[];
  /** Configured git platform for PR/MR creation, or undefined to disable. */
  gitPlatform?: GitPlatform;
  /** Merged env values: existing + collected + seeded stack secrets. */
  envValues: Record<string, string>;
  /** The seeded OmniRoute stack secret additions (never rotates a set key). */
  secrets: Record<string, string>;
  /** The detected GPU vendor, echoed back for the executor's log line. */
  hardware: HardwareVendor;
}

/**
 * Builds the ordered `e init` plan for a disk state and wizard answers, purely.
 * Everything the action writes — and the order, and the never-clobber rules —
 * is decided here and asserted by tests; the executor only applies {@link InitWrite}
 * specs and logs. Re-init subtlety: `.env` sections are appended, not rewritten,
 * and `applyEnvValues` fills blank `KEY=` lines only, so a hand-edited or
 * already-seeded `.env` survives untouched.
 */
export function planInit(state: InitState, answers: InitAnswers): InitPlan {
  const {
    root,
    harnessNames,
    currentDefaultHarness,
    currentModels,
    currentLocalRuntimes,
    hardware,
  } = state;
  const existingValues = state.existingEnvContent
    ? parseDotenv(state.existingEnvContent)
    : {};

  // Resolve the choices: a blank or unanswered prompt keeps the configured
  // current, so `--yes` and a non-TTY fallback match the interactive flow.
  const defaultHarness =
    answers.harness === undefined
      ? currentDefaultHarness
      : (parseHarnessChoice(
          answers.harness,
          harnessNames,
          currentDefaultHarness
        ) ?? currentDefaultHarness);
  const localRuntimes = resolveLocalRuntimes(
    answers.localRuntimes,
    currentLocalRuntimes
  );
  // The model prompt is index-aligned with the union of the selected runtimes'
  // catalogs, so resolution must use that same merged catalog.
  const catalog = composeModelCatalog(localRuntimes, state.runtimeCatalogs);
  const models = resolveModels(answers.models, catalog, currentModels);
  const gitPlatform = resolveGitPlatform(
    answers.gitPlatform,
    state.gitPlatforms,
    state.currentGitPlatform
  );

  // Merge collected API keys and the wizard's OmniRoute password, then seed the
  // stack secrets (never rotating what is already set). Agents are rendered
  // with these merged values, as is the `.env` body, matching the historic
  // write order. A user-typed password lands in envValues before seeding, so
  // seedStackSecrets keeps it; a blank answer leaves the key unset and the
  // seeder generates a fresh random password.
  const envValues = {
    ...existingValues,
    ...(answers.apiKeys ?? {}),
    ...(answers.omniroutePassword
      ? { OMNIROUTE_INITIAL_PASSWORD: answers.omniroutePassword }
      : {}),
  };
  const secrets = seedStackSecrets(envValues);
  const fullEnv = { ...envValues, ...secrets };

  const steps: InitStep[] = [];

  // Step 1 — each harness's Dockerfile + default agent (never clobbered).
  for (const harness of Object.values(HARNESSES)) {
    steps.push({
      kind: 'harness',
      name: harness.name,
      writes: [
        {
          directory: harnessDir(harness.name, root),
          file: dockerfilePath(harness.name, root),
          content: renderDockerfile(harness.dockerfile),
          clobber: 'never',
        },
        {
          directory: agentDir(harness.name, root),
          file: agentFilePath(harness.name, root),
          content: renderDefaultAgent(harness.name, fullEnv),
          clobber: 'never',
        },
      ],
    });
  }

  // Step 2 — shipped MCP servers, then shipped skills (never clobbered).
  const mcpWrites: InitWrite[] = [];
  for (const [name, render] of Object.entries(SHIPPED_MCP_SERVERS)) {
    const dir = mcpDir(name, root);
    for (const [fileName, content] of Object.entries(render())) {
      mcpWrites.push({
        directory: dir,
        file: path.join(dir, fileName),
        content,
        clobber: 'never',
      });
    }
  }
  const skillWrites: InitWrite[] = [];
  for (const [name, render] of Object.entries(SHIPPED_SKILLS)) {
    const dir = skillDir(name, root);
    for (const [relPath, content] of Object.entries(render())) {
      const file = path.join(dir, relPath);
      skillWrites.push({
        directory: path.dirname(file),
        file,
        content,
        clobber: 'never',
      });
    }
  }
  if (mcpWrites.length > 0 || skillWrites.length > 0) {
    steps.push({ kind: 'writes', writes: [...mcpWrites, ...skillWrites] });
  }

  // Step 2b — the shared egress gateway build context + blacklist template
  // (never clobbered). The image is built once and runs as a global compose
  // service shared by all stack services and agents (ADR-0011).
  const egressWrites: InitWrite[] = [];
  const egressCtx = egressDir(root);
  for (const [fileName, content] of Object.entries(renderEgressFiles())) {
    egressWrites.push({
      directory: egressCtx,
      file: path.join(egressCtx, fileName),
      content,
      clobber: 'never',
    });
  }
  const egressBlacklistFile = egressBlacklistPath(root);
  egressWrites.push({
    directory: path.dirname(egressBlacklistFile),
    file: egressBlacklistFile,
    content: renderEgressFiles()['blacklist.example'],
    clobber: 'never',
  });
  if (egressWrites.length > 0) {
    steps.push({ kind: 'writes', writes: egressWrites });
  }

  // Step 3 — selected runtimes' derived bootstrap state (provider registration
  // only; model downloads happen on demand via `e <runtime> download <model>`).
  if (localRuntimes.length > 0) {
    const bootstrapFile = bootstrapScriptPath(root);
    steps.push({
      kind: 'bootstrap',
      write: {
        directory: path.dirname(bootstrapFile),
        file: bootstrapFile,
        content: renderBootstrap(localRuntimes, models[0] ?? ''),
        clobber: 'always',
      },
    });
  }

  // Step 4 — derived Compose state. Re-render so a re-init can change runtime selection.
  steps.push({
    kind: 'compose',
    write: {
      directory: path.dirname(dockerComposePath(root)),
      file: dockerComposePath(root),
      content: renderCompose(hardware, localRuntimes),
      clobber: 'always',
    },
  });

  return {
    steps,
    env: buildEnvWrite(root, state.existingEnvContent, fullEnv),
    config: { defaultHarness, models, localRuntimes, gitPlatform },
    defaultHarness,
    models,
    localRuntimes,
    gitPlatform,
    envValues: fullEnv,
    secrets,
    hardware,
  };
}

/** Resolves an extensible runtime multi-select; blank keeps the current set. */
export function resolveLocalRuntimes(
  answer: InitAnswers['localRuntimes'],
  current: LocalRuntime[]
): LocalRuntime[] {
  if (answer === undefined) return current;
  if (Array.isArray(answer)) return answer;
  const trimmed = answer.trim();
  if (trimmed === '') return current;
  if (trimmed.toLowerCase() === 'all') return LOCAL_RUNTIMES.map(r => r.id);
  if (trimmed.toLowerCase() === 'none') return [];
  const parts = trimmed
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return current;
  const selected = new Set<LocalRuntime>();
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return current;
    const runtime = LOCAL_RUNTIMES[Number(part) - 1];
    if (!runtime) return current;
    selected.add(runtime.id);
  }
  return [...selected];
}

/**
 * Resolves a model multi-select answer, purely: a pre-resolved id list passes
 * through, a raw answer is parsed with `parseModelChoice`, and a blank or
 * unanswered prompt keeps the `current` selection.
 */
function resolveModels(
  answer: InitAnswers['models'],
  catalog: ModelCatalogEntry[],
  current: string[]
): string[] {
  if (answer === undefined) return current;
  if (Array.isArray(answer)) return answer;
  return parseModelChoice(answer, catalog, current) ?? current;
}

/**
 * Resolves the git-platform answer, purely: an unanswered prompt (a `--yes`
 * re-init) keeps the configured `current`; a blank answer disables PR/MR
 * creation (undefined); a named or 1-based-indexed choice selects it.
 */
function resolveGitPlatform(
  answer: InitAnswers['gitPlatform'] | undefined,
  platforms: GitPlatform[],
  current: GitPlatform | undefined
): GitPlatform | undefined {
  if (answer === undefined) return current;
  const trimmed = answer.trim();
  if (trimmed === '') return undefined;
  return parseGitPlatformChoice(trimmed, platforms) as GitPlatform | undefined;
}

/**
 * Builds the planned `.env` write, purely: a missing file renders the full
 * template (with the e-net section); an existing file gains only the
 * sections it lacks; collected values fill blank `KEY=` lines only. The
 * `created`/`changed` outcome tells the executor whether to write or report
 * the file up to date.
 */
function buildEnvWrite(
  root: string | undefined,
  existingContent: string | undefined,
  envValues: Record<string, string>
): InitPlan['env'] {
  const file = envFilePath(root);
  const sections = [
    ...envHarnessSections(),
    // The OmniRoute stack section: compose interpolates these from `.e/.env`
    // (no fallbacks), so an old `.e/.env` gains the lines on re-init too.
    { name: STACK_NETWORK, env: [...OMNIROUTE_STACK_SECRETS] },
  ];

  let content: string;
  if (existingContent === undefined) {
    content = renderEnvTemplate({ harnesses: sections });
  } else {
    const missing = sections.filter(
      section => !existingContent.includes(`# --- ${section.name} ---`)
    );
    if (missing.length === 0) {
      content = existingContent;
    } else {
      const separator = existingContent.endsWith('\n') ? '\n' : '\n\n';
      content =
        existingContent +
        separator +
        renderEnvTemplate({ harnesses: missing, includeHeader: false });
    }
  }

  content = applyEnvValues(content, envValues);

  return {
    file,
    content,
    created: existingContent === undefined,
    changed: existingContent !== undefined && content !== existingContent,
  };
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
 * Resolves a git-platform prompt answer, purely: a blank answer is the
 * interactive prompt's "disable" sentinel (handled by the caller), an exact
 * name or a 1-based index selects that platform, and anything else is
 * unrecognized (`undefined`, so the glue re-prompts).
 */
export function parseGitPlatformChoice(
  input: string,
  platforms: readonly string[]
): string | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return undefined;
  if (platforms.includes(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) {
    const idx = Number(trimmed) - 1;
    if (idx >= 0 && idx < platforms.length) return platforms[idx]!;
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
