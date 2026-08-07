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
 * Builds the per-harness sections for the shared `.env` template — one entry
 * per harness, carrying that harness's `requiredEnv` verbatim (no dedup).
 */
export function envHarnessSections(): EnvHarnessSection[] {
  return Object.values(HARNESSES).map((harness) => ({
    name: harness.name,
    env: harness.requiredEnv,
  }));
}
