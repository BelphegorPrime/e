import fs from 'fs';
import path from 'path';
import { MODELS } from '../modelStatus.js';
import { isLocalRuntime, type LocalRuntime } from '../localRuntimes.js';
import {
  configFilePath,
  dockerfilePath,
  egressDir,
  modelsFilePath,
} from './paths.js';
import { log } from '../../shared/utils/log.js';

/**
 * The Store's **state files** (host-only): `config.json` orchestration
 * settings, `model-ids.json`, and the per-harness `Dockerfile` presence that
 * answers "has `e init` provisioned this harness?". The pure resolvers
 * ({@link resolveConfig}, {@link resolveModels}) take already-parsed JSON so
 * the read/write glue stays thin and the defaults are testable without disk.
 */

/** The favorite harness a bare `e spawn` resolves to when none is named. */
export const DEFAULT_HARNESS = 'pi';

/** Supported git platforms for PR/MR creation. */
export type GitPlatform = 'github' | 'gitlab' | 'forgejo' | 'gitea';

/** Every platform `e init` offers, in prompt order. */
export const GIT_PLATFORMS: readonly GitPlatform[] = [
  'github',
  'gitlab',
  'forgejo',
  'gitea',
];

/**
 * The sibling-artifact allowlist when `config.json` sets none (ADR-0013):
 * the parent's `node_modules` travels into a sibling's container.
 */
export const DEFAULT_SIBLING_ARTIFACTS: readonly string[] = ['node_modules'];

/** The fan-out bound when `config.json` sets none: siblings in flight per run (ADR-0013). */
export const DEFAULT_MAX_SIBLINGS = 3;

/**
 * The **verify** command that decides whether a run's work is accepted
 * (ADR-0016): the repository's own check, run as a second container against
 * the run's worktree after the commit. Its exit code is the run's verdict.
 * A Store that declares none has no gate.
 */
export type VerifyConfig = {
  /** The command, run through `sh -c` inside the verify container. */
  command: string;
  /**
   * The image the check runs in; defaults to the run's harness image. All four
   * harness images are `node:lts-alpine` plus git plus the harness CLI, so the
   * default covers Node repos and nothing else.
   */
  image?: string;
  /** Wall clock for the check; a timeout is a red verdict, not a broken check. */
  timeoutMs?: number;
  /** Give the check a network - it installs its own dependencies. */
  network?: boolean;
  /** Mount a per-Store package cache outside the worktree. Off by default. */
  cache?: boolean;
};

/** Host-only orchestration settings, persisted in `config.json`. */
export type StoreConfig = {
  /** The favorite harness `e spawn` resolves to when no target is named. */
  defaultHarness: string;
  /** Local llama.cpp models `e init` provisions; `e spawn` waits for exactly these. */
  models: string[];
  /** Local AI runtimes selected during `e init`. */
  localRuntimes: LocalRuntime[];
  /** Git platform for PR/MR creation after successful runs. */
  gitPlatform?: GitPlatform;
  /**
   * Build artifacts copied from a parent worktree into a sibling run's
   * container (ADR-0013), as paths relative to the worktree; default
   * `node_modules`. `.env` and `.git` are never copied whatever is listed.
   * An empty list disables the sync.
   */
  siblingArtifacts: string[];
  /** Siblings a run may have in flight at once (ADR-0013); a positive integer, default 3. */
  maxSiblings: number;
  /** The repository's verify command (ADR-0016); absent means no gate and no loop. */
  verify?: VerifyConfig;
};

export type ModelDataEntry = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
};

/**
 * Resolves the `verify` block: the string shorthand is the command and nothing
 * else, the object form is per-key like the rest of {@link resolveConfig}, so
 * one malformed field never costs the gate. Absent, or without a usable
 * command, yields `undefined` - a Store with no gate.
 */
function resolveVerify(raw: unknown): VerifyConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') {
    if (raw.length > 0) return { command: raw };
    log.warn('Ignoring verify: the command is empty');
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    log.warn('Ignoring verify: expected a command string or an object');
    return undefined;
  }
  const parsed = raw as Partial<VerifyConfig>;
  if (typeof parsed.command !== 'string' || parsed.command.length === 0) {
    log.warn('Ignoring verify: no usable command');
    return undefined;
  }
  const image =
    typeof parsed.image === 'string' && parsed.image.length > 0
      ? parsed.image
      : undefined;
  const timeoutMs =
    typeof parsed.timeoutMs === 'number' &&
    Number.isInteger(parsed.timeoutMs) &&
    parsed.timeoutMs > 0
      ? parsed.timeoutMs
      : undefined;
  const network =
    typeof parsed.network === 'boolean' ? parsed.network : undefined;
  const cache = typeof parsed.cache === 'boolean' ? parsed.cache : undefined;
  return {
    command: parsed.command,
    // Spread each optional key so a resolved block deep-equals what was
    // declared: an absent field is an absent key, never `undefined`.
    ...(image !== undefined ? { image } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(network !== undefined ? { network } : {}),
    ...(cache !== undefined ? { cache } : {}),
  };
}

/**
 * Resolves a parsed `config.json` body to a complete {@link StoreConfig},
 * applying built-in defaults for anything absent or malformed. Pure: the glue
 * hands it the already-parsed JSON (or `undefined` when the file is missing).
 */
export function resolveConfig(raw: unknown): StoreConfig {
  const parsed = (raw ?? {}) as Partial<StoreConfig>;
  const defaultHarness =
    typeof parsed.defaultHarness === 'string' &&
    parsed.defaultHarness.length > 0
      ? parsed.defaultHarness
      : DEFAULT_HARNESS;
  const models =
    Array.isArray(parsed.models) &&
    parsed.models.length > 0 &&
    parsed.models.every(m => typeof m === 'string')
      ? parsed.models
      : MODELS;
  // Older stores predate runtime selection and historically provisioned llama.
  const localRuntimes = Array.isArray(parsed.localRuntimes)
    ? parsed.localRuntimes.filter(isLocalRuntime)
    : (['llamacpp'] as LocalRuntime[]);
  const gitPlatform =
    typeof parsed.gitPlatform === 'string' &&
    GIT_PLATFORMS.includes(parsed.gitPlatform as GitPlatform)
      ? parsed.gitPlatform
      : undefined;
  const siblingArtifacts =
    Array.isArray(parsed.siblingArtifacts) &&
    parsed.siblingArtifacts.every(entry => typeof entry === 'string')
      ? parsed.siblingArtifacts
      : [...DEFAULT_SIBLING_ARTIFACTS];
  const maxSiblings =
    typeof parsed.maxSiblings === 'number' &&
    Number.isInteger(parsed.maxSiblings) &&
    parsed.maxSiblings >= 1
      ? parsed.maxSiblings
      : DEFAULT_MAX_SIBLINGS;
  const verify = resolveVerify(parsed.verify);
  return {
    defaultHarness,
    models,
    localRuntimes,
    gitPlatform,
    siblingArtifacts,
    maxSiblings,
    // Spread, not `verify,`: a Store with no gate must resolve to exactly the
    // object it did before this key existed - `{ verify: undefined }` is a key.
    ...(verify ? { verify } : {}),
  };
}

/**
 * Resolves a parsed `model-ids.json` body to a complete {@link ModelDataEntry} array,
 * applying built-in defaults for anything absent or malformed. Pure: the glue
 * hands it the already-parsed JSON (or `undefined` when the file is missing).
 */
export function resolveModels(raw: unknown): ModelDataEntry[] {
  const parsed = (raw ?? []) as Partial<ModelDataEntry[]>;
  return Array.isArray(parsed)
    ? parsed.filter((v): v is ModelDataEntry => !!v)
    : [];
}

/** Serializes a {@link StoreConfig} to the on-disk `config.json` text. */
export function serializeConfig(
  config: Record<string, unknown> | Array<unknown>
): string {
  return JSON.stringify(config, null, 2) + '\n';
}

/**
 * Reads the host-only `model-ids.json`, applying defaults for anything absent - a
 * missing file yields the built-in defaults.
 */
export function readModelsJson(root?: string): ModelDataEntry[] {
  const file = modelsFilePath(root);
  if (!fs.existsSync(file)) {
    return resolveModels(undefined);
  }
  return resolveModels(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** Writes the host-only `model-ids.json`, creating the `.e` directory if needed. */
export function writeModelsJson(config: ModelDataEntry[], root?: string): void {
  const file = modelsFilePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeConfig(config));
}

/**
 * Reads the host-only `config.json`, applying defaults for anything absent - a
 * missing file yields the built-in defaults ({@link DEFAULT_HARNESS}).
 */
export function readConfig(root?: string): StoreConfig {
  const file = configFilePath(root);
  if (!fs.existsSync(file)) {
    log.debug(`No config.json at ${file}, using defaults`);
    return resolveConfig(undefined);
  }
  log.debug(`Reading config.json at ${file}`);
  return resolveConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** Writes the host-only `config.json`, creating the `.e` directory if needed. */
export function writeConfig(config: StoreConfig, root?: string): void {
  const file = configFilePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeConfig(config));
}

/** Returns true if `e init` has written this harness's Dockerfile under `root`. */
export function isInitialized(name: string, root?: string): boolean {
  return fs.existsSync(dockerfilePath(name, root));
}

/** Returns true when the shared egress build context has been seeded by `e init` (ADR-0011). */
export function isEgressInitialized(root?: string): boolean {
  return fs.existsSync(path.join(egressDir(root), 'Dockerfile'));
}
