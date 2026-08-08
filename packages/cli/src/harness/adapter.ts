/**
 * The per-harness **config adapter** seam (ADR-0006). `e` owns a uniform,
 * structured input — a {@link Provider} — and each Harness owns the translation
 * into its own native delivery form. This slice implements only the *env-based*
 * form used by an env-configured harness (Claude Code): a Provider becomes a set
 * of container env vars. File-based rendering and derived images (#11) come
 * later; this module deliberately knows nothing about images, files, or runs.
 */

/**
 * A model wire protocol — the concrete HTTP API an endpoint speaks. "OpenAI" is
 * not monolithic: `openai-chat` (`/v1/chat/completions`) and `openai-responses`
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
];

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
 * A harness's config adapter. Env-based harnesses implement
 * {@link renderProviderEnv}; file-based harnesses (Codex, opencode) will grow a
 * file-rendering method in a later slice (#11).
 */
export interface HarnessAdapter {
  /** Renders a Provider into the container env vars this harness reads. */
  renderProviderEnv(provider: Provider): ContainerEnv[];
}

/**
 * Claude Code's adapter. Claude speaks only the Anthropic Messages API and is
 * configured purely through env vars: `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`,
 * and an auth credential. We deliver the key as `ANTHROPIC_AUTH_TOKEN` (the
 * `Authorization: Bearer` form used by Anthropic-compatible gateways) referenced
 * by name from `.e/.env`. See `docs/research/harness-cli-facts.md`.
 */
export const claudeCodeAdapter: HarnessAdapter = {
  renderProviderEnv(provider: Provider): ContainerEnv[] {
    return [
      { name: 'ANTHROPIC_BASE_URL', value: provider.baseUrl },
      { name: 'ANTHROPIC_MODEL', value: provider.model },
      { name: 'ANTHROPIC_AUTH_TOKEN', fromEnv: provider.apiKeyEnv },
    ];
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
