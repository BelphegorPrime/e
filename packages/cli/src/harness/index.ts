import type { DockerfileParams } from './renderDockerfile';
import type { EnvHarnessSection } from './renderEnvTemplate';
import type {
  Protocol,
  HarnessAdapter,
  FileHarnessAdapter,
  ConfigOverlayDelivery,
} from './adapter';
import type { McpEndpoint } from '../mcp/index';
import { claudeCodeAdapter, codexAdapter, piAdapter, PI_PROVIDER_ID } from './adapter';
import { imageTag as eImageTag } from '../naming';

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
  /**
   * Absolute in-container directory this harness reads Agent Skills from, outside
   * `/workspace` so skills never land in a run's branch (e.g. Claude
   * `/root/.claude/skills`, the shared `/root/.agents/skills` for the others).
   * Its presence is the harness's declared skill capability; absent → `--skill`
   * and baked skills are rejected. Grounding: `docs/research/harness-cli-facts.md`.
   */
  skillsDir?: string;
}

/**
 * The shared in-container Agent-Skills directory read by Codex, opencode, and pi
 * (`~/.agents/skills`, running as root). Claude Code reads its own
 * `~/.claude/skills` instead. Grounding: `docs/research/harness-cli-facts.md`.
 */
const AGENTS_SKILLS_DIR = '/root/.agents/skills';

/** Available coding harnesses, keyed by name. */
export const HARNESSES: Record<string, Harness> = {
  pi: {
    name: 'pi',
    imageTag: eImageTag('harness', 'pi'),
    dockerfile: {
      label: 'Pi Coding Agent CLI harness.',
      npmPackage: '@earendil-works/pi-coding-agent',
      npmFlags: ['--ignore-scripts'],
    },
    requiredEnv: ['ANTHROPIC_API_KEY'],
    // pi speaks all four wire protocols (its `openai-completions` is our
    // `openai-chat`). It is file-configured: a custom endpoint lives only in
    // `models.json` (no base-url env var), so the provider is delivered via the
    // file adapter, baked into the derived agent image. Grounding:
    // `docs/research/harness-cli-facts.md`, pi `docs/models.md`.
    protocols: ['anthropic-messages', 'openai-chat', 'openai-responses'],
    adapter: piAdapter,
    // pi selects a configured provider explicitly; the resolved model is passed
    // for selection when an agent declares a provider (a default agent runs
    // `pi -p <prompt>` and uses pi's own built-in default).
    buildCommand: (prompt: string, model?: string) =>
      model
        ? ['pi', '-p', `"${prompt}"`, '--provider', PI_PROVIDER_ID, '--model', model]
        : ['pi', '-p', `"${prompt}"`],
    // pi reads Agent Skills from the shared `~/.agents/skills`.
    skillsDir: AGENTS_SKILLS_DIR,
  },
  claudeCode: {
    name: 'claudeCode',
    imageTag: eImageTag('harness', 'claudeCode'),
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
    // Claude Code reads Agent Skills from `~/.claude/skills` (not `.agents/`).
    skillsDir: '/root/.claude/skills',
  },
  codex: {
    name: 'codex',
    imageTag: eImageTag('harness', 'codex'),
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
    // Codex reads Agent Skills from the shared `~/.agents/skills`.
    skillsDir: AGENTS_SKILLS_DIR,
  },
  opencode: {
    name: 'opencode',
    imageTag: eImageTag('harness', 'opencode'),
    dockerfile: {
      label: 'opencode CLI harness.',
      npmPackage: 'opencode-ai',
    },
    requiredEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    // opencode (Vercel AI SDK) speaks all four via its provider plugins.
    protocols: ['anthropic-messages', 'openai-chat', 'openai-responses'],
    buildCommand: (prompt: string) => ['opencode', 'run', prompt],
    // opencode reads Agent Skills from the shared `~/.agents/skills`.
    skillsDir: AGENTS_SKILLS_DIR,
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
 *  - `none` — no MCP client at all (pi, whose file adapter renders no MCP), or no
 *    MCP delivery wired yet; `--mcp` is rejected with a clear error at spawn.
 */
export type McpDeliveryForm = 'flag' | 'file' | 'none';

/**
 * The MCP delivery form a harness declares — the single classifier of the
 * `flag`/`file`/`none` fork. Internal: both {@link harnessCapabilities} (for
 * gating) and {@link planMcpDelivery} (for wiring) derive from it, so the label
 * and the wiring it implies can never disagree.
 */
function mcpDeliveryForm(harness: Harness): McpDeliveryForm {
  if (harness.renderMcpArgs) return 'flag';
  // A file adapter delivers MCP only if it renders an overlay; pi is a file
  // harness for its provider but ships no MCP client, so it stays `none`.
  if (harness.adapter?.kind === 'file' && harness.adapter.planConfigOverlay) {
    return 'file';
  }
  return 'none';
}

/**
 * The harness's file config adapter when it has one, else undefined — narrows the
 * {@link HarnessAdapter} union so {@link planMcpDelivery} avoids an
 * `as FileHarnessAdapter` cast. Internal to this module.
 */
function fileAdapterFor(harness: Harness): FileHarnessAdapter | undefined {
  return harness.adapter?.kind === 'file' ? harness.adapter : undefined;
}

/**
 * What a harness can do, as a small described value — the presence/form gates the
 * spawn edge checks before a run (ADR-0006/0008). It replaces the scatter of
 * optional-field probes (`adapter?`, `renderMcpArgs?`, `skillsDir?`) that
 * `validateSpawn` used to reassemble by hand: each field states one capability.
 * Gating only — `planSpawn` still fetches the real `adapter` and calls
 * {@link planMcpDelivery} for the wiring a form implies. (Protocol compatibility
 * is a set-membership check with its own home, `validateProviderProtocol`, so it
 * is deliberately not a capability here.)
 */
export interface HarnessCapabilities {
  /** How a provider is delivered: env vars, a baked config file, or no adapter. */
  provider: 'env' | 'file' | 'none';
  /** How MCP config is delivered (see {@link McpDeliveryForm}). */
  mcp: McpDeliveryForm;
  /** The in-container skills dir, or undefined when the harness supports no skills. */
  skills: string | undefined;
}

/** Describes a harness's capabilities for the spawn edge's gating (see {@link HarnessCapabilities}). */
export function harnessCapabilities(harness: Harness): HarnessCapabilities {
  return {
    provider: harness.adapter ? harness.adapter.kind : 'none',
    mcp: mcpDeliveryForm(harness),
    skills: harness.skillsDir,
  };
}

/**
 * How the selected MCP servers reach a harness, as data — the wiring a
 * {@link McpDeliveryForm} implies, decided in one place so `planSpawn` no longer
 * re-branches on `renderMcpArgs` vs the file adapter (ADR-0006):
 *  - `flag` — extra argv for the run command (Claude's `--mcp-config`).
 *  - `file` — a config overlay merged onto `baseConfig` (Codex's `config.toml`).
 *  - `none` — no delivery; the spawn edge rejects `--mcp` against such a harness
 *    before ever calling this, so it is unreachable in a valid run (defensive).
 */
export type McpDelivery =
  | { form: 'flag'; args: string[] }
  | { form: 'file'; overlay: ConfigOverlayDelivery }
  | { form: 'none' };

/**
 * Plans MCP delivery for a harness, given the selected `endpoints` and the baked
 * provider `baseConfig` a file overlay merges onto (empty for a default agent).
 * Dispatches on the single {@link mcpDeliveryForm} classifier — the label and the
 * wiring share one source, so they cannot drift. The non-null assertions are
 * guaranteed by that classifier: a `flag` form has `renderMcpArgs`; a `file` form
 * has a file adapter with `planConfigOverlay`.
 */
export function planMcpDelivery(
  harness: Harness,
  endpoints: McpEndpoint[],
  baseConfig: string,
): McpDelivery {
  const form = mcpDeliveryForm(harness);
  switch (form) {
    case 'flag':
      return { form, args: harness.renderMcpArgs!(endpoints) };
    case 'file':
      return {
        form,
        overlay: fileAdapterFor(harness)!.planConfigOverlay!(baseConfig, endpoints),
      };
    case 'none':
      return { form };
  }
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
  const optionalEnvKeys = ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL'];

  const seen = new Set<string>(optionalEnvKeys);
  
  for (const harness of Object.values(HARNESSES)) {
    for (const key of harness.requiredEnv) {
      seen.add(key);
    }
  }
  
  return [...seen];
}
