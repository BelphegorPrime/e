/**
 * The per-harness **config adapter** seam (ADR-0006). `e` owns a uniform,
 * structured input — a {@link Provider} — and each Harness owns the translation
 * into its own native delivery form, modelled as the {@link HarnessAdapter}
 * discriminated union: the *env* form for an env-configured harness (Claude
 * Code) delivers container env vars at runtime; the *file* form for a
 * file-configured harness (Codex) renders a config file baked into a derived
 * agent image (ADR-0004), with only the API key delivered at runtime.
 */

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
  /** Concrete model id (or `auto`, resolved later — see #12). */
  model: string;
  /** The wire protocol the endpoint speaks; must be one the harness speaks. */
  protocol: Protocol;
  /** Name of the env var (in `.e/.env`) holding the API key — never the value. */
  apiKeyEnv: string;
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
  /** Renders the Provider into this harness's native config file. */
  renderProviderFile(provider: Provider): RenderedConfigFile;
  /**
   * The runtime env the derived image still needs — the API key, by name only
   * (never baked). The baked config file points at it via the harness's own
   * key-by-name mechanism (Codex `env_key`).
   */
  renderRuntimeEnv(provider: Provider): ContainerEnv[];
}

/**
 * A harness's config adapter. Each harness ingests configuration through its own
 * mechanism, so the adapter is a discriminated union over the *delivery form*:
 * `env` for env-configured harnesses (Claude Code), `file` for file-configured
 * ones baked into a derived agent image (Codex). See ADR-0006.
 */
export type HarnessAdapter = EnvHarnessAdapter | FileHarnessAdapter;

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
 * The model must be a concrete id: `auto` is resolved at spawn and delivered at
 * runtime (ADR-0004/0006, tracked by #12), never baked into the image — so an
 * `auto` model is rejected here rather than written as a literal.
 */
export function renderCodexConfig(provider: Provider): string {
  if (provider.model === 'auto') {
    throw new Error(
      `Codex cannot bake an "auto" model into a derived agent image; set a concrete model id ` +
        `(automatic per-tier model resolution is tracked separately).`,
    );
  }
  // A fixed provider id: `e` owns the whole file, so there is only ever one
  // custom provider and no id collision to worry about.
  const id = 'e';
  return (
    [
      `model = ${tomlBasicString(provider.model)}`,
      `model_provider = ${tomlBasicString(id)}`,
      ``,
      `[model_providers.${id}]`,
      `name = ${tomlBasicString(id)}`,
      `base_url = ${tomlBasicString(provider.baseUrl)}`,
      `env_key = ${tomlBasicString(provider.apiKeyEnv)}`,
      `wire_api = "responses"`,
    ].join('\n') + '\n'
  );
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
  renderProviderFile(provider: Provider): RenderedConfigFile {
    return { fileName: 'config.toml', content: renderCodexConfig(provider) };
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
 * Renders adapter-produced {@link ContainerEnv} entries into `.env` file content
 * (one `NAME=value` line each), delivered to the container via `--env-file` so
 * no value lands on argv. A `fromEnv` entry's value is resolved via `resolve`
 * (the parsed `.e/.env`); a missing key is a hard error naming the fix, because
 * running with an empty credential would fail opaquely deep inside the harness.
 */
export function renderProviderEnvFile(
  entries: ContainerEnv[],
  resolve: (name: string) => string | undefined,
): string {
  const lines = entries.map((entry) => {
    if ('value' in entry) return `${entry.name}=${entry.value}`;
    const value = resolve(entry.fromEnv);
    if (value === undefined || value === '') {
      throw new Error(
        `Provider API key env "${entry.fromEnv}" is not set in .e/.env. ` +
          `Add "${entry.fromEnv}=<key>" there — its value is injected at runtime, never baked into an image.`,
      );
    }
    return `${entry.name}=${value}`;
  });
  return lines.join('\n') + '\n';
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
