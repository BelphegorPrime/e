import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The **Store**: the `.e` directory holding e's on-disk state — the per-harness
 * Dockerfiles under `harnesses/`, the Agent definitions under `agents/`, the
 * container MCP server definitions under `mcp/`, the Skills under `skills/`, and
 * the shared `.env` base environment. This module owns the store's layout (path
 * derivation keyed on a harness, agent, MCP-server, or skill *name*) and the
 * root-finding walk that locates it. It knows nothing about the Harness, Agent,
 * MCP, or Skill registries, so the dependency runs one way:
 * `harness`/`agent`/`mcp`/`skill` → `store`.
 */

/**
 * The `.e` directory under `root` that holds all of e's state (harness
 * Dockerfiles, the shared `.env`, ...).
 * `root` defaults to the user's home directory; `e init --dir <path>` uses
 * `<path>` as the root instead (e.g. to init into the current project).
 */
export function eBaseDir(root: string = os.homedir()): string {
  return path.join(root, '.e');
}

/** Base directory that holds the harness Dockerfiles, under `root`. */
export function harnessesBaseDir(root?: string): string {
  return path.join(eBaseDir(root), 'harnesses');
}

/** Base directory that holds the Agent definitions, under `root`. */
export function agentsBaseDir(root?: string): string {
  return path.join(eBaseDir(root), 'agents');
}

/** Base directory that holds the container MCP server definitions, under `root`. */
export function mcpBaseDir(root?: string): string {
  return path.join(eBaseDir(root), 'mcp');
}

/** Base directory that holds the Skill definitions, under `root`. */
export function skillsBaseDir(root?: string): string {
  return path.join(eBaseDir(root), 'skills');
}

/** Directory containing a single Skill's files (`SKILL.md` + optional resources). */
export function skillDir(name: string, root?: string): string {
  return path.join(skillsBaseDir(root), name);
}

/** Absolute path to a Skill's `SKILL.md` manifest — the file that makes a dir a skill. */
export function skillManifestPath(name: string, root?: string): string {
  return path.join(skillDir(name, root), 'SKILL.md');
}

/** Directory containing a single MCP server's definition (Dockerfile + mcp.json). */
export function mcpDir(name: string, root?: string): string {
  return path.join(mcpBaseDir(root), name);
}

/** Absolute path to an MCP server's `mcp.json` metadata file. */
export function mcpConfigPath(name: string, root?: string): string {
  return path.join(mcpDir(name, root), 'mcp.json');
}

/** Directory containing a single agent's definition. */
export function agentDir(name: string, root?: string): string {
  return path.join(agentsBaseDir(root), name);
}

/** Absolute path to an agent's definition file. */
export function agentFilePath(name: string, root?: string): string {
  return path.join(agentDir(name, root), 'agent.json');
}

/**
 * Path to the shared `.env` file loaded as the base environment for every
 * harness container. Lives alongside the `harnesses/` dir under `.e`.
 */
export function envFilePath(root?: string): string {
  return path.join(eBaseDir(root), '.env');
}

/** Absolute path to the Store's Docker Compose file written by `e init`. */
export function dockerComposePath(root?: string): string {
  return path.join(eBaseDir(root), 'compose.yaml');
}

/** Absolute path to the generated Compose bootstrap script written by `e init`. */
export function bootstrapScriptPath(root?: string): string {
  return path.join(eBaseDir(root), 'bootstrap.sh');
}

/**
 * Path to the host-only `config.json`. Unlike `.env`, this file holds
 * orchestration settings for the host and is **never injected into a
 * container** — nothing in the spawn path passes it as environment.
 */
export function configFilePath(root?: string): string {
  return path.join(eBaseDir(root), 'config.json');
}

/** Absolute path to an agent's definition file. */
export function modelsFilePath(root?: string): string {
  return path.join(eBaseDir(root), 'model-ids.json');
}

/** The favorite harness a bare `e spawn` resolves to when none is named. */
export const DEFAULT_HARNESS = 'pi';

/** Host-only orchestration settings, persisted in `config.json`. */
export type StoreConfig = {
  /** The favorite harness `e spawn` resolves to when no target is named. */
  defaultHarness: string;
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
  return { defaultHarness };
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
 * Reads the host-only `model-ids.json`, applying defaults for anything absent — a
 * missing file yields the built-in defaults ({@link DEFAULT_HARNESS}).
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
 * Reads the host-only `config.json`, applying defaults for anything absent — a
 * missing file yields the built-in defaults ({@link DEFAULT_HARNESS}).
 */
export function readConfig(root?: string): StoreConfig {
  const file = configFilePath(root);
  if (!fs.existsSync(file)) return resolveConfig(undefined);
  return resolveConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** Writes the host-only `config.json`, creating the `.e` directory if needed. */
export function writeConfig(config: StoreConfig, root?: string): void {
  const file = configFilePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeConfig(config));
}

/** Directory containing a single harness's Dockerfile. */
export function harnessDir(name: string, root?: string): string {
  return path.join(harnessesBaseDir(root), name);
}

/** Absolute path to a harness's Dockerfile. */
export function dockerfilePath(name: string, root?: string): string {
  return path.join(harnessDir(name, root), 'Dockerfile');
}

/** Returns true if `e init` has written this harness's Dockerfile under `root`. */
export function isInitialized(name: string, root?: string): boolean {
  return fs.existsSync(dockerfilePath(name, root));
}

/** Inputs to the pure root resolution; the glue supplies the real values. */
export interface ResolveRootInput {
  /** `--dir <path>` value, if the user passed one. */
  explicitDir: string | undefined;
  /** The directory the walk-up starts from (normally `process.cwd()`). */
  cwd: string;
  /** The user's home directory, tried last. */
  homedir: string;
  /** Predicate: does this candidate directory contain a `.e` store? */
  hasStore: (dir: string) => boolean;
}

/**
 * Resolves the root directory that holds the `.e` store, purely.
 *
 * Resolution order:
 *  1. `explicitDir` (from `--dir`), resolved to an absolute path.
 *  2. The nearest ancestor of `cwd` (walking up to the filesystem root) that
 *     contains a `.e` store.
 *  3. The home directory, if it contains a `.e` store.
 *
 * Returns `undefined` if none of the candidates contain a store.
 */
export function resolveRoot({
  explicitDir,
  cwd,
  homedir,
  hasStore,
}: ResolveRootInput): string | undefined {
  if (explicitDir) return path.resolve(explicitDir);

  let dir = cwd;
  while (true) {
    if (hasStore(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }

  if (hasStore(homedir)) return homedir;

  return undefined;
}

/** True if `p` exists and is a directory. */
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Locates the store root against the real filesystem: wires `process.cwd()`,
 * `os.homedir()`, and a `statSync`-based `hasStore` predicate into the pure
 * {@link resolveRoot}.
 */
export function findRoot(explicitDir?: string): string | undefined {
  return resolveRoot({
    explicitDir,
    cwd: process.cwd(),
    homedir: os.homedir(),
    hasStore: dir => isDir(path.join(dir, '.e')),
  });
}
