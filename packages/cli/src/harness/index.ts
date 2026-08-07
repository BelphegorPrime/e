import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DockerfileParams } from './renderDockerfile';
import type { EnvHarnessSection } from './renderEnvTemplate';

/** A coding harness that runs inside a container built from its own Dockerfile. */
export interface Harness {
  /** Registry key, e.g. "claudeCode". */
  name: string;
  /** Tag for the image built from this harness's Dockerfile. */
  imageTag: string;
  /** Template parameters used to render this harness's Dockerfile. */
  dockerfile: DockerfileParams;
  /** Env vars this harness expects to find (typically supplied via --env-file). */
  requiredEnv: string[];
  /** Builds the container argv that invokes the harness with the given prompt. */
  buildCommand(prompt: string): string[];
}

/** Available coding harnesses, keyed by name. */
export const HARNESSES: Record<string, Harness> = {
  pi: {
    name: 'pi',
    imageTag: 'e-harness-pi',
    dockerfile: {
      label: 'Pi Coding Agent CLI harness.',
      npmPackage: '@earendil-works/pi-coding-agent',
      npmFlags: ['--ignore-scripts'],
    },
    requiredEnv: ['ANTHROPIC_API_KEY'],
    buildCommand: (prompt: string) => ['pi', '-p', prompt],
  },
  claudeCode: {
    name: 'claudeCode',
    imageTag: 'e-harness-claudecode',
    dockerfile: {
      label: 'Claude Code CLI harness.',
      npmPackage: '@anthropic-ai/claude-code',
    },
    requiredEnv: ['ANTHROPIC_API_KEY'],
    buildCommand: (prompt: string) => [
      'claude',
      '-p',
      prompt,
      '--dangerously-skip-permissions',
    ],
  },
  codex: {
    name: 'codex',
    imageTag: 'e-harness-codex',
    dockerfile: {
      label: 'OpenAI Codex CLI harness.',
      npmPackage: '@openai/codex',
    },
    requiredEnv: ['OPENAI_API_KEY'],
    buildCommand: (prompt: string) => ['codex', 'exec', prompt],
  },
  opencode: {
    name: 'opencode',
    imageTag: 'e-harness-opencode',
    dockerfile: {
      label: 'opencode CLI harness.',
      npmPackage: 'opencode-ai',
    },
    requiredEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    buildCommand: (prompt: string) => ['opencode', 'run', prompt],
  },
};

/**
 * Resolves a harness by name, throwing with the list of valid names if unknown.
 */
export function resolveHarness(name: string): Harness {
  const harness = HARNESSES[name];
  if (!harness) {
    throw new Error(
      `Unknown harness "${name}". Valid values: ${Object.keys(HARNESSES).join(', ')}.`,
    );
  }
  return harness;
}

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

/**
 * Path to the shared `.env` file loaded as the base environment for every
 * harness container. Lives alongside the `harnesses/` dir under `.e`.
 */
export function envFilePath(root?: string): string {
  return path.join(eBaseDir(root), '.env');
}

/**
 * Builds the per-harness sections for the shared `.env` template — one entry
 * per harness, carrying that harness's `requiredEnv` verbatim (no dedup).
 */
export function envHarnessSections(): EnvHarnessSection[] {
  return Object.values(HARNESSES).map((harness) => ({
    name: harness.name,
    env: harness.requiredEnv,
  }));
}

/** Directory containing a single harness's Dockerfile. */
export function harnessDir(harness: Harness, root?: string): string {
  return path.join(harnessesBaseDir(root), harness.name);
}

/** Absolute path to a harness's Dockerfile. */
export function dockerfilePath(harness: Harness, root?: string): string {
  return path.join(harnessDir(harness, root), 'Dockerfile');
}

/** Returns true if `e init` has written this harness's Dockerfile under `root`. */
export function isInitialized(harness: Harness, root?: string): boolean {
  return fs.existsSync(dockerfilePath(harness, root));
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
 * Resolves the root directory that holds the `.e/harnesses` tree.
 *
 * Resolution order:
 *  1. `explicitDir` (from `--dir`), resolved to an absolute path.
 *  2. The nearest ancestor of the current working directory (walking up to
 *     `/`) that contains a `.e` directory.
 *  3. The user's home directory, if it contains a `.e` directory.
 *
 * Returns `undefined` if none of the candidates contain a `.e` directory.
 */
export function findHarnessRoot(explicitDir?: string): string | undefined {
  if (explicitDir) return path.resolve(explicitDir);

  let dir = process.cwd();
  while (true) {
    if (isDir(path.join(dir, '.e'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }

  const home = os.homedir();
  if (isDir(path.join(home, '.e'))) return home;

  return undefined;
}
