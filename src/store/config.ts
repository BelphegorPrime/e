import fs from 'fs';
import path from 'path';
import { MODELS } from '../modelStatus.js';
import { isLocalRuntime, type LocalRuntime } from '../init/localRuntimes.js';
import {
  configFilePath,
  dockerfilePath,
  egressDir,
  modelsFilePath,
} from './paths.js';
import { log } from '../utils/log.js';

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
};

export type ModelDataEntry = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
};

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
  return {
    defaultHarness,
    models,
    localRuntimes,
    gitPlatform,
    siblingArtifacts,
    maxSiblings,
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
