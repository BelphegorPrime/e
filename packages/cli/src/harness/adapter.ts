/**
 * The per-harness **config adapter** seam (ADR-0006). `e` owns a uniform,
 * structured input — a {@link Provider} — and each Harness owns the translation
 * into its own native delivery form, modelled as the {@link HarnessAdapter}
 * discriminated union: the *env* form for an env-configured harness (Claude
 * Code) delivers container env vars at runtime; the *file* form for a
 * file-configured harness (Codex) renders a config file baked into a derived
 * agent image (ADR-0004), with only the API key delivered at runtime.
 */

import type { McpEndpoint } from '../mcp/index';
import { SpawnFacts } from '../spawnPlan';

/**
 * Every model wire protocol `e` recognises — the single source of truth. A
 * protocol is the concrete HTTP API an endpoint speaks. "OpenAI" is not
 * monolithic: `openai-chat` (`/v1/chat/completions`) and `openai-responses`
 * (`/v1/responses`) are distinct, and a harness may speak one without the other.
 * See `docs/research/harness-cli-facts.md`.
 */
export type Protocol =
  | 'anthropic-messages'
  | 'openai-chat'
  | 'openai-responses'
  | 'google';

/** Every protocol string `e` recognises, for validating persisted agents. */
export const PROTOCOLS: readonly Protocol[] = [
  'anthropic-messages',
  'openai-chat',
  'openai-responses',
  'google',
] as const;

/**
 * The model endpoint an Agent talks to, declared inline in the Agent. The API
 * key is referenced by the *name* of the env var that holds it (`apiKeyEnv`);
 * the value lives in `.e/.env` and is injected at runtime, never baked into an
 * image. See the CLI CONTEXT's "Provider" entry.
 */
export interface Provider {
  /** Base URL of the endpoint, e.g. `https://gateway.example.com`. */
  baseUrl: string;
  baseUrlEnv?: string;
  /** Concrete model id, or `auto` — resolved at spawn against `/v1/models` (ADR-0007). */
  model: string;
  /** The wire protocol the endpoint speaks; must be one the harness speaks. */
  protocol: Protocol;
  /** Name of the env var (in `.e/.env`) holding the API key — never the value. */
  apiKeyEnv: string;
  /**
   * Fallback model id used when `model` is `auto` but resolution finds no
   * preferred model or the endpoint is unreachable (ADR-0007). Optional; without
   * it an unresolvable `auto` is a hard error.
   */
  defaultModel?: string;
}

/**
 * One container env var contributed by an adapter. A `value` entry carries a
 * literal (non-secret config like a base URL or model id); a `fromEnv` entry
 * delivers a secret *by name* — its value is resolved from `.e/.env` at delivery
 * time and never appears in the adapter output, so secrets stay out of code and
 * argv.
 */
export type ContainerEnv =
  | { name: string; value: string }
  | { name: string; fromEnv: string };

/**
 * A config file an adapter renders for a file-configured harness, to be baked
 * into a **derived agent image** (ADR-0004 layer 2). It is written under
 * `.e/agents/<name>/` on the host and `COPY`d into the image at
 * {@link FileHarnessAdapter.configDir} — a path outside `/workspace`, so
 * `e`-generated config never lands in the Run's branch (ADR-0006).
 */
export interface RenderedConfigFile {
  /** File name written under the agent dir and copied into the image. */
  fileName: string;
  /** The rendered file content. */
  content: string;
}

/**
 * A file harness's complete MCP config-overlay delivery (ADR-0006 layer 3),
 * structured so the spawn edge never has to know *where* the harness reads its
 * config. The adapter owns its config dir, file name, and relocation env var; it
 * hands back the merged file to materialize, the container path to mount it at,
 * and the env that points the CLI at the mounted dir. The edge fills in the host
 * path (after writing the file) and formats the mount.
 */
export interface ConfigOverlayDelivery {
  /** The merged config file to materialize; its `fileName` is the harness's config file. */
  file: RenderedConfigFile;
  /** Absolute container path to mount {@link file} at (`configDir/configFileName`); outside `/workspace`. */
  mountTo: string;
  /** Env (as `NAME=value` argv entries) relocating the harness's config dir to the mount. */
  env: string[];
}

/**
 * An **env-based** config adapter (Claude Code): a {@link Provider} becomes a
 * set of container env vars, delivered at runtime via `--env-file`.
 */
export interface EnvHarnessAdapter {
  kind: 'env';
  /** Renders a Provider into the container env vars this harness reads. */
  renderProviderEnv(provider: Provider): ContainerEnv[];
}

/**
 * A **file-based** config adapter (Codex): a {@link Provider} becomes a config
 * file baked into a derived agent image, read from a relocated config dir. The
 * API key is never baked — the file references it by env var name (Codex's
 * `env_key`), and {@link renderRuntimeEnv} delivers that name at runtime, so the
 * secret stays a runtime value (ADR-0006).
 */
export interface FileHarnessAdapter {
  kind: 'file';
  /**
   * Name of the env var that relocates this harness's config dir (e.g.
   * `CODEX_HOME`). Set in the derived image so the CLI reads config from
   * {@link configDir} rather than a `$HOME`-relative default.
   */
  configDirEnv: string;
  /** Absolute in-container config dir the file is baked into; outside `/workspace`. */
  configDir: string;
  /** The config file name this harness reads under {@link configDir} (e.g. `config.toml`). */
  configFileName: string;
  /**
   * Whether a resolved model must be materialised into the config file. Codex can
   * receive an `auto`-resolved model on the command line (`-m <id>`) and keep its
   * config model-agnostic, so it sets `false`; pi selects only models **declared**
   * in `models.json`, so it sets `true` and every resolved model is baked (ADR-0007
   * staleness applies: a newly-shipped `auto` pick needs `--rebuild`). See
   * {@link planProviderDelivery} and `docs/research/harness-cli-facts.md`.
   */
  modelInFile: boolean;
  /** Renders the Provider into this harness's native config file. */
  renderProviderFile(facts: SpawnFacts, provider: Provider): RenderedConfigFile;
  /**
   * The runtime env the derived image still needs — the API key, by name only
   * (never baked). The baked config file points at it via the harness's own
   * key-by-name mechanism (Codex `env_key`, pi `${VAR}` interpolation).
   */
  renderRuntimeEnv(provider: Provider): ContainerEnv[];
  /**
   * Renders the selected MCP servers into this harness's native config as a
   * runtime-overlay fragment (ADR-0006 layer 3), to be merged onto the baked
   * base config and delivered outside `/workspace` via {@link configDir}.
   * Container sidecars use streamable HTTP (a `url`); returns an empty string
   * when nothing is selected. **Optional** — absent for a file harness that ships
   * no MCP client (pi), which the spawn edge capability-gates off.
   */
  renderMcpServers?(endpoints: McpEndpoint[]): string;
  /**
   * Plans the complete MCP config-overlay delivery: merges the selected servers
   * onto the baked `baseConfig` (the exact config the derived image baked, reused
   * not re-derived; empty for a default agent with no provider) and returns the
   * merged file, the container path to mount it at, and the config-dir relocation
   * env — everything the spawn edge needs without touching this adapter's
   * {@link configDir}/{@link configFileName}/{@link configDirEnv} fields. Pure —
   * the edge writes the file, formats the mount, and appends the env. **Optional**
   * — its presence is the harness's declared file-MCP capability; absent for pi
   * (no MCP client). See {@link planMcpDelivery}.
   */
  planConfigOverlay?(baseConfig: string, endpoints: McpEndpoint[]): ConfigOverlayDelivery;
}

/**
 * A harness's config adapter. Each harness ingests configuration through its own
 * mechanism, so the adapter is a discriminated union over the *delivery form*:
 * `env` for env-configured harnesses (Claude Code), `file` for file-configured
 * ones baked into a derived agent image (Codex). See ADR-0006.
 */
export type HarnessAdapter = EnvHarnessAdapter | FileHarnessAdapter;

export const isEnvAdapter = (adapter: HarnessAdapter): adapter is EnvHarnessAdapter => adapter.kind === 'env';
export const isFileAdapter = (adapter: HarnessAdapter): adapter is FileHarnessAdapter => adapter.kind === 'file';

/**
 * Claude Code's adapter. Claude speaks only the Anthropic Messages API and is
 * configured purely through env vars: `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`,
 * and an auth credential. We deliver the key as `ANTHROPIC_AUTH_TOKEN` (the
 * `Authorization: Bearer` form used by Anthropic-compatible gateways) referenced
 * by name from `.e/.env`. See `docs/research/harness-cli-facts.md`.
 */
export const claudeCodeAdapter: EnvHarnessAdapter = {
  kind: 'env',
  renderProviderEnv(provider: Provider): ContainerEnv[] {
    return [
      { name: 'ANTHROPIC_BASE_URL', value: provider.baseUrl },
      { name: 'ANTHROPIC_MODEL', value: provider.model },
      { name: 'ANTHROPIC_AUTH_TOKEN', fromEnv: provider.apiKeyEnv },
    ];
  },
};

/**
 * Escapes a value for a TOML basic string (the `"..."` form): backslash and
 * double-quote are the two characters that would otherwise break the literal.
 * Our inputs (URLs, model ids, env var names) are unlikely to contain either,
 * but rendering config is not the place to assume that.
 */
function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Renders a {@link Provider} into a Codex `config.toml` body. Codex speaks only
 * the OpenAI *Responses* API, so a custom endpoint is expressed as a named
 * provider with `wire_api = "responses"` and selected at the top level. The key
 * is referenced by env var name (`env_key`); Codex reads it from the process
 * environment at runtime, so no secret is written here. Grounding:
 * `docs/research/harness-cli-facts.md`.
 *
 * A concrete model is baked as the top-level `model` (ADR-0004). An `auto` model
 * is **omitted** from the file — it is resolved at spawn and delivered at runtime
 * (`codex exec -m <id>`, ADR-0007), so the derived image is not rebuilt when the
 * resolved model changes.
 */
export function renderCodexConfig(facts: SpawnFacts, provider: Provider): string {
  // A fixed provider id: `e` owns the whole file, so there is only ever one
  // custom provider and no id collision to worry about.
  const id = 'e';
  const lines: string[] = [];
  // `auto` carries no concrete id to bake; it arrives at runtime via `-m`.
  if (provider.model !== 'auto') {
    lines.push(`model = ${tomlBasicString(provider.model)}`);
  }
  lines.push(
    `model_provider = ${tomlBasicString(id)}`,
    ``,
    `[model_providers.${id}]`,
    `name = ${tomlBasicString(id)}`,
    `base_url = ${tomlBasicString(provider.baseUrl)}`,
    `env_key = ${tomlBasicString(provider.apiKeyEnv)}`,
    `wire_api = "responses"`,
  );
  return lines.join('\n') + '\n';
}

/**
 * Renders the selected MCP endpoints into Codex `[mcp_servers.<name>]` TOML
 * blocks. A `url` denotes a streamable-HTTP server (Codex's only HTTP transport;
 * no `transport`/`type` key and no experimental flag are needed — verified
 * against `config.schema.json`'s `RawMcpServerConfig`) — used for container
 * sidecars reached at `http://<alias>:<port>/mcp`. Any endpoint `headers` are
 * rendered as Codex `http_headers` verbatim; Codex does not expand `${VAR}`, so a
 * secret-bearing remote header is a Codex-native concern (its `env_http_headers`
 * / `bearer_token_env_var`, which reference an env var by name) and out of this
 * slice's container scope. Grounding: `docs/research/harness-cli-facts.md`.
 */
export function renderCodexMcpServers(endpoints: McpEndpoint[]): string {
  const blocks = endpoints.map((endpoint) => {
    const lines = [
      `[mcp_servers.${tomlBareKey(endpoint.name)}]`,
      `url = ${tomlBasicString(endpoint.url)}`,
    ];
    if (endpoint.headers && Object.keys(endpoint.headers).length > 0) {
      const pairs = Object.entries(endpoint.headers).map(
        ([key, value]) => `${tomlBasicString(key)} = ${tomlBasicString(value)}`,
      );
      lines.push(`http_headers = { ${pairs.join(', ')} }`);
    }
    return lines.join('\n');
  });
  return blocks.length > 0 ? blocks.join('\n\n') + '\n' : '';
}

/**
 * Renders a TOML bare key when the name is a bare-key-safe identifier, else a
 * quoted key. MCP server names are directory names, so they are normally bare;
 * this keeps a name with dots or dashes valid as a table key.
 */
function tomlBareKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlBasicString(name);
}

/**
 * Codex's adapter. Codex is configured through `config.toml` under its config
 * dir (relocatable via `CODEX_HOME`), so the provider is rendered into a file
 * baked into the derived agent image; only the API key is delivered at runtime,
 * by name. The config dir is a fixed path outside `/workspace`.
 */
export const codexAdapter: FileHarnessAdapter = {
  kind: 'file',
  configDirEnv: 'CODEX_HOME',
  configDir: '/root/.codex',
  configFileName: 'config.toml',
  // Codex delivers an auto-resolved model on the command line (`codex exec -m`),
  // so it keeps the config model-agnostic rather than baking the model.
  modelInFile: false,
  renderProviderFile(facts: SpawnFacts, provider: Provider): RenderedConfigFile {
    return { fileName: 'config.toml', content: renderCodexConfig(facts,provider) };
  },
  renderRuntimeEnv(provider: Provider): ContainerEnv[] {
    return [{ name: provider.apiKeyEnv, fromEnv: provider.apiKeyEnv }];
  },
  renderMcpServers(endpoints: McpEndpoint[]): string {
    return renderCodexMcpServers(endpoints);
  },
  planConfigOverlay(baseConfig: string, endpoints: McpEndpoint[]): ConfigOverlayDelivery {
    const block = renderCodexMcpServers(endpoints);
    const content = (baseConfig ? baseConfig.trimEnd() + '\n\n' : '') + block;
    return {
      file: { fileName: this.configFileName, content },
      mountTo: `${this.configDir}/${this.configFileName}`,
      env: [`${this.configDirEnv}=${this.configDir}`],
    };
  },
};

/**
 * The fixed provider id `e` writes into pi's `models.json`. `e` owns the whole
 * file, so there is only ever one custom provider and no id collision. Shared
 * with pi's `buildCommand`, which selects it via `--provider <id>`.
 */
export const PI_PROVIDER_ID = 'e';

/**
 * Maps e's wire {@link Protocol} to pi's `api` field value. Two names differ from
 * e's: our `openai-chat` is pi's `openai-completions`, and our `google` is pi's
 * `google-generative-ai`. Grounding: pi `docs/models.md` "Supported APIs".
 */
export function piApi(protocol: Protocol): string {
  switch (protocol) {
    case 'anthropic-messages':
      return 'anthropic-messages';
    case 'openai-chat':
      return 'openai-completions';
    case 'openai-responses':
      return 'openai-responses';
    case 'google':
      return 'google-generative-ai';
  }
}

/**
 * Renders a {@link Provider} into a pi `models.json` body: one custom provider
 * (id `e`) carrying the endpoint, the mapped `api`, the API key referenced by env
 * var name via pi's `${VAR}` interpolation (never a secret value — pi resolves it
 * from the process env at request time), and the one model to select.
 *
 * Unlike Codex, pi selects only models **declared** in `models.json`, so the
 * (spawn-resolved, concrete) model is always written here — {@link
 * planProviderDelivery} guarantees a concrete id even for `auto`. Grounding: pi
 * `docs/models.md`, `docs/providers.md`.
 */
export function renderPiModelsJson(facts: SpawnFacts, provider: Provider): string {
  const store = facts.storeEnv;
  const baseUrl = provider.baseUrlEnv ? store[provider.baseUrlEnv] : provider.baseUrl;
  const apiKey = store[provider.apiKeyEnv] || ""

  const config = {
    providers: {
      [PI_PROVIDER_ID]: {
        baseUrl: baseUrl,
        api: piApi(provider.protocol),
        apiKey: apiKey,
        models: [{ id: provider.model }],
      },
    },
  };
  return JSON.stringify(config, null, 2) + '\n';
}

/**
 * pi's adapter. pi is configured through `models.json` under its config dir
 * (relocatable via `PI_CODING_AGENT_DIR`), so the provider is rendered into a
 * file baked into the derived agent image; only the API key is delivered at
 * runtime, by name. pi ships **no MCP client** (`docs/usage.md` Design
 * Principles), so it carries no `renderMcpServers`/`planConfigOverlay` — the
 * spawn edge capability-gates `--mcp pi` off (see {@link harnessCapabilities}). pi
 * requires the model declared in the file, so `modelInFile` is `true`.
 */
export const piAdapter: FileHarnessAdapter = {
  kind: 'file',
  configDirEnv: 'PI_CODING_AGENT_DIR',
  configDir: '/root/.pi/agent',
  configFileName: 'models.json',
  modelInFile: true,
  renderProviderFile(facts: SpawnFacts, provider: Provider): RenderedConfigFile {
    return { fileName: 'models.json', content: renderPiModelsJson(facts, provider) };
  },
  renderRuntimeEnv(provider: Provider): ContainerEnv[] {
    return [{ name: provider.apiKeyEnv, fromEnv: provider.apiKeyEnv }];
  },
};

/** A harness's identity and the protocol set it speaks, for protocol validation. */
interface HarnessProtocols {
  name: string;
  protocols: readonly Protocol[];
}

/**
 * Rejects an agent whose provider protocol is not one its harness speaks, before
 * any image build or run. A default agent without a provider always passes.
 */
export function validateProviderProtocol(
  provider: Provider | undefined,
  harness: HarnessProtocols,
): void {
  if (!provider) return;
  if (!harness.protocols.includes(provider.protocol)) {
    throw new Error(
      `Harness "${harness.name}" does not speak protocol "${provider.protocol}"; ` +
        `it speaks: ${harness.protocols.join(', ')}. ` +
        `Point this agent at a compatible endpoint or use a different harness.`,
    );
  }
}

/**
 * Renders {@link ContainerEnv} entries into `.env` file content (one `NAME=value`
 * line each), delivered to the container via `--env-file` so no value lands on
 * argv. Constructed once with the parsed `.e/.env` resolver and reused for every
 * credential env-file a spawn writes — the provider's and each MCP server's — so
 * the secret resolution and its single fail-loud live in one place (ADR-0006/0008).
 */
export class EnvFileRenderer {
  constructor(private readonly resolve: (name: string) => string | undefined) {}

  /**
   * Renders `entries` to env-file content. A `value` entry inlines its literal; a
   * `fromEnv` entry is resolved by name, and a missing or empty value is a hard
   * error. `subject` names who needs the key (e.g. `Provider API key`, `MCP server
   * "everything"`) so the one message stays specific — running with an empty
   * credential would otherwise fail opaquely deep inside the harness.
   */
  render(entries: ContainerEnv[], subject: string): string {
    const lines = entries.map((entry) => {
      if ('value' in entry) return `${entry.name}=${entry.value}`;
      const value = this.resolve(entry.fromEnv);
      if (value === undefined || value === '') {
        throw new Error(
          `${subject} env "${entry.fromEnv}" is not set in .e/.env. ` +
            `Add "${entry.fromEnv}=<value>" there — its value is injected at runtime, never baked into an image.`,
        );
      }
      return `${entry.name}=${value}`;
    });
    return lines.join('\n') + '\n';
  }
}

/**
 * Parses `.env`-style content into a key→value map, following docker's
 * `--env-file` basics: `KEY=VALUE` lines, `#` comment lines and blank lines
 * ignored, the value taken verbatim after the first `=` (no quote stripping).
 */
export function parseDotenv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === '') continue;
    env[key] = line.slice(eq + 1);
  }
  return env;
}
