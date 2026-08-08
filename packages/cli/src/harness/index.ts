import type { DockerfileParams } from './renderDockerfile';
import type { EnvHarnessSection } from './renderEnvTemplate';
import type { Protocol, HarnessAdapter, FileHarnessAdapter } from './adapter';
import type { McpEndpoint } from '../mcp/index';
import { claudeCodeAdapter, codexAdapter } from './adapter';

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
  /**
   * The wire protocols this harness speaks. A provider's protocol must be one of
   * these — see {@link validateProviderProtocol}. Grounding:
   * `docs/research/harness-cli-facts.md`.
   */
  protocols: readonly Protocol[];
  /**
   * The config adapter that renders a provider into this harness's native form
   * (env vars for an env-based harness). Absent until a harness has an adapter;
   * a default agent (no provider) never needs one.
   */
  adapter?: HarnessAdapter;
  /**
   * Builds the container argv that invokes the harness with the given prompt.
   * `model` is an optional runtime-resolved model to pass on the command line
   * (used by harnesses that take the model as a flag, e.g. Codex `-m`); harnesses
   * that carry the model via env or a baked config ignore it.
   */
  buildCommand(prompt: string, model?: string): string[];
  /**
   * Wires container MCP sidecar endpoints into this harness, returning the extra
   * argv to append to {@link buildCommand}. Present only for harnesses that take
   * MCP config inline via a flag (Claude Code's `--mcp-config`); absent for
   * harnesses that need a rendered config file or support no MCP — the spawn edge
   * capability-gates on its presence. Grounding: `docs/research/harness-cli-facts.md`.
   */
  renderMcpArgs?(endpoints: McpEndpoint[]): string[];
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
    // pi speaks all four wire protocols (its `openai-completions` is our
    // `openai-chat`). Its env-based adapter comes with the pi delivery slice.
    protocols: ['anthropic-messages', 'openai-chat', 'openai-responses', 'google'],
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
    // Claude Code speaks only the Anthropic Messages API and is configured via
    // env vars, so it carries the env-based adapter.
    protocols: ['anthropic-messages'],
    adapter: claudeCodeAdapter,
    buildCommand: (prompt: string) => [
      'claude',
      '-p',
      prompt,
      '--dangerously-skip-permissions',
    ],
    // Claude takes MCP config inline: `--mcp-config '<json>'` with a streamable
    // HTTP server def per server (type "http"). No file, no restart. A remote
    // server may carry auth headers whose `${VAR}` values Claude expands from the
    // container env at runtime, so the secret is never written onto argv.
    renderMcpArgs: (endpoints: McpEndpoint[]) => {
      if (endpoints.length === 0) return [];
      type HttpServer = { type: 'http'; url: string; headers?: Record<string, string> };
      const mcpServers: Record<string, HttpServer> = {};
      for (const endpoint of endpoints) {
        const server: HttpServer = { type: 'http', url: endpoint.url };
        if (endpoint.headers) server.headers = endpoint.headers;
        mcpServers[endpoint.name] = server;
      }
      return ['--mcp-config', JSON.stringify({ mcpServers })];
    },
  },
  codex: {
    name: 'codex',
    imageTag: 'e-harness-codex',
    dockerfile: {
      label: 'OpenAI Codex CLI harness.',
      npmPackage: '@openai/codex',
    },
    requiredEnv: ['OPENAI_API_KEY'],
    // Codex speaks only OpenAI Responses (`/v1/chat/completions` was removed).
    protocols: ['openai-responses'],
    // Codex is file-configured (`config.toml`): its adapter renders the provider
    // block into a derived agent image (ADR-0004/0006). An auto-resolved model
    // arrives at runtime as `-m <id>` (a baked concrete model needs no flag).
    adapter: codexAdapter,
    buildCommand: (prompt: string, model?: string) =>
      model ? ['codex', 'exec', '-m', model, prompt] : ['codex', 'exec', prompt],
  },
  opencode: {
    name: 'opencode',
    imageTag: 'e-harness-opencode',
    dockerfile: {
      label: 'opencode CLI harness.',
      npmPackage: 'opencode-ai',
    },
    requiredEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    // opencode (Vercel AI SDK) speaks all four via its provider plugins.
    protocols: ['anthropic-messages', 'openai-chat', 'openai-responses', 'google'],
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
 * How a harness accepts MCP server config, its declared MCP capability (ADR-0006):
 *  - `flag` — inline on the command line (Claude Code's `--mcp-config`).
 *  - `file` — rendered into its native config file, delivered as a runtime
 *    overlay via its file adapter (Codex's `config.toml` / `CODEX_HOME`).
 *  - `none` — no MCP client at all (pi), or no MCP delivery wired yet; `--mcp` is
 *    rejected with a clear error at spawn.
 */
export type McpDeliveryForm = 'flag' | 'file' | 'none';

/** The MCP delivery form a harness declares (see {@link McpDeliveryForm}). */
export function mcpDeliveryForm(harness: Harness): McpDeliveryForm {
  if (harness.renderMcpArgs) return 'flag';
  if (harness.adapter?.kind === 'file') return 'file';
  return 'none';
}

/**
 * The harness's file config adapter when it has one, else undefined — narrows the
 * {@link HarnessAdapter} union so callers avoid an `as FileHarnessAdapter` cast.
 */
export function fileAdapterFor(harness: Harness): FileHarnessAdapter | undefined {
  return harness.adapter?.kind === 'file' ? harness.adapter : undefined;
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

/**
 * The deduped union of every harness's `requiredEnv` — the set of API keys
 * `e init` collects into `.e/.env`, in first-seen order across the registry.
 */
export function requiredEnvKeys(): string[] {
  const seen = new Set<string>();
  for (const harness of Object.values(HARNESSES)) {
    for (const key of harness.requiredEnv) seen.add(key);
  }
  return [...seen];
}
