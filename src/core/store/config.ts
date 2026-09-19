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

/**
 * Container limits that apply to **every** run, interactive included, and to
 * the verify container (ADR-0016). Not to sidecars: those are `e`'s own
 * infrastructure, small and known, and limiting them breaks `e` in a way the
 * user cannot diagnose.
 */
export type ResourceCaps = {
  /** `--memory`, e.g. `4g`. Unset by default. */
  memory?: string;
  /** `--cpus`. Unset by default. */
  cpus?: number;
  /** `--pids-limit`; a floor against a fork bomb, not a tuning knob. */
  pidsLimit: number;
};

/**
 * Bounds on the loop (ADR-0016). They shadow one another, so the defaults are
 * chosen as a set: a run's worst case is
 * `maxIterations x (iterationTimeoutMs + verify timeout)`, and a
 * `totalTimeoutMs` below that would make the iteration count a lie.
 */
export type LoopCaps = {
  /** Attempts before the run is exhausted. Three harness runs in total. */
  maxIterations: number;
  /** Wall clock per attempt; applies to every non-interactive run. */
  iterationTimeoutMs: number;
  /** Wall clock for the whole run; kills mid-attempt. */
  totalTimeoutMs: number;
  /**
   * A mark that only warns, at the attempt boundary, to the human - never
   * into the prompt. Dropped when it is not below {@link totalTimeoutMs},
   * where it could never fire.
   */
  softTotalTimeoutMs?: number;
};

/**
 * The check's wall clock when the declaration names none (ADR-0016). A suite
 * over 15 minutes is unusual, and a verify timeout is red-and-iterate rather
 * than an abort, so the default can be tight.
 */
export const DEFAULT_VERIFY_TIMEOUT_MS = 15 * 60 * 1000;

/** `resources` when `config.json` sets none: a fork-bomb floor and nothing else. */
export const DEFAULT_RESOURCE_CAPS: ResourceCaps = { pidsLimit: 2048 };

/** `loop` when `config.json` sets none (ADR-0016). */
export const DEFAULT_LOOP_CAPS: LoopCaps = {
  maxIterations: 3,
  iterationTimeoutMs: 30 * 60 * 1000,
  totalTimeoutMs: 3 * 60 * 60 * 1000,
  softTotalTimeoutMs: 2 * 60 * 60 * 1000,
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
  /** Container limits for every run and for the check (ADR-0016). */
  resources: ResourceCaps;
  /** Bounds on the loop (ADR-0016). */
  loop: LoopCaps;
};

export type ModelDataEntry = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
};

/**
 * A positive-integer field, or undefined when absent or unusable - the
 * per-key habit of {@link resolveConfig}: one bad field never costs the block.
 */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** A block that is absent, or not an object, resolves to no overrides at all. */
function asBlock(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** Resolves the `resources` block over {@link DEFAULT_RESOURCE_CAPS}. */
function resolveResources(raw: unknown): ResourceCaps {
  const block = asBlock(raw);
  const memory =
    typeof block.memory === 'string' && block.memory.length > 0
      ? block.memory
      : undefined;
  const cpus =
    typeof block.cpus === 'number' && block.cpus > 0 ? block.cpus : undefined;
  return {
    ...(memory !== undefined ? { memory } : {}),
    ...(cpus !== undefined ? { cpus } : {}),
    pidsLimit: positiveInt(block.pidsLimit) ?? DEFAULT_RESOURCE_CAPS.pidsLimit,
  };
}

/** Resolves the `loop` block over {@link DEFAULT_LOOP_CAPS}. */
function resolveLoop(raw: unknown): LoopCaps {
  const block = asBlock(raw);
  const totalTimeoutMs =
    positiveInt(block.totalTimeoutMs) ?? DEFAULT_LOOP_CAPS.totalTimeoutMs;
  const soft =
    positiveInt(block.softTotalTimeoutMs) ??
    DEFAULT_LOOP_CAPS.softTotalTimeoutMs;
  // A soft mark at or past the hard one can never fire, so it is dropped
  // rather than kept as a setting that silently does nothing.
  const softTotalTimeoutMs =
    soft !== undefined && soft < totalTimeoutMs ? soft : undefined;
  if (soft !== undefined && softTotalTimeoutMs === undefined) {
    log.warn(
      `Ignoring loop.softTotalTimeoutMs (${soft}ms): it is not below totalTimeoutMs (${totalTimeoutMs}ms), so it could never warn`
    );
  }
  return {
    maxIterations:
      positiveInt(block.maxIterations) ?? DEFAULT_LOOP_CAPS.maxIterations,
    iterationTimeoutMs:
      positiveInt(block.iterationTimeoutMs) ??
      DEFAULT_LOOP_CAPS.iterationTimeoutMs,
    totalTimeoutMs,
    ...(softTotalTimeoutMs !== undefined ? { softTotalTimeoutMs } : {}),
  };
}

/**
 * Resolves the `verify` block: the string shorthand is the command and nothing
 * else, the object form is per-key like the rest of {@link resolveConfig}, so
 * one malformed field never costs the gate. Absent, or without a usable
 * command, yields `undefined` - a Store with no gate.
 */
function resolveVerify(raw: unknown): VerifyConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') {
    if (raw.length > 0)
      return { command: raw, timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS };
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
    // declared: an absent field is an absent key, never `undefined`. The
    // timeout is the exception - the caps own its default, so it is always
    // present once resolved and `runVerify` needs no second source for it.
    ...(image !== undefined ? { image } : {}),
    timeoutMs: timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
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
    resources: resolveResources(parsed.resources),
    loop: resolveLoop(parsed.loop),
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

/**
 * Reads the config for a run whose repository may not be the Store that
 * started it (ADR-0016). One `e serve` can hold a trigger that names another
 * checkout, and the gate and the limits are not the serving machine's to
 * decide: **the check belongs to the repository**.
 *
 * So `verify`, `loop` and `resources` come from the target repository's own
 * Store when it has one, and from the serving Store otherwise; every other
 * setting stays the serving Store's, because it describes this machine. The
 * chain is per file rather than per key: a repository that keeps a
 * `config.json` and declares no gate has no gate, and inheriting one from
 * whoever happened to serve it would be a stranger's check on your code.
 */
export function readConfigChain(roots: {
  serving?: string;
  target?: string;
}): StoreConfig {
  const serving = readConfig(roots.serving);
  if (!roots.target || !fs.existsSync(configFilePath(roots.target))) {
    return serving;
  }
  const target = readConfig(roots.target);
  const machine = { ...serving };
  // The target's config is authoritative for the gate, its absence included.
  delete machine.verify;
  return {
    ...machine,
    ...(target.verify ? { verify: target.verify } : {}),
    loop: target.loop,
    resources: target.resources,
  };
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
