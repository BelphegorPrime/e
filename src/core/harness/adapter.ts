/**
 * The per-harness **config adapter** seam (ADR-0006). `e` owns a uniform,
 * structured input - a {@link Provider} - and each Harness owns the translation
 * into its own native delivery form, modelled as the {@link HarnessAdapter}
 * discriminated union: the *env* form for an env-configured harness (Claude
 * Code) delivers container env vars at runtime; the *file* form for a
 * file-configured harness (Codex) renders a config file baked into a derived
 * agent image (ADR-0004), with only the API key delivered at runtime.
 */

import { isDeepStrictEqual } from 'node:util';
import type { McpEndpoint } from '../mcp/index.js';
import { NODE_HOME } from './renderDockerfile.js';
import { log } from '../../shared/utils/log.js';

/**
 * Every model wire protocol `e` recognises - the single source of truth. A
 * protocol is the concrete HTTP API an endpoint speaks. "OpenAI" is not
 * monolithic: `openai-chat` (`/v1/chat/completions`) and `openai-responses`
 * (`/v1/responses`) are distinct, and a harness may speak one without the other.
 * See `docs/research/harness-cli-facts.md`.
 */
export type Protocol =
  'openai-chat' | 'anthropic-messages' | 'openai-responses';

/** Every protocol string `e` recognises, for validating persisted agents. */
export const PROTOCOLS: readonly Protocol[] = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
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
  /** Concrete model id, or `auto` - resolved at spawn against `/v1/models` (ADR-0007). */
  model: string;
  /** The wire protocol the endpoint speaks; must be one the harness speaks. */
  protocol: Protocol;
  /** Name of the env var (in `.e/.env`) holding the API key - never the value. */
  apiKeyEnv: string;
}

/**
 * One container env var contributed by an adapter. A `value` entry carries a
 * literal (non-secret config like a base URL or model id); a `fromEnv` entry
 * delivers a secret *by name* - its value is resolved from `.e/.env` at delivery
 * time and never appears in the adapter output, so secrets stay out of code and
 * argv.
 */
export type ContainerEnv =
  { name: string; value: string } | { name: string; fromEnv: string };

/**
 * A config file an adapter renders for a file-configured harness, to be baked
 * into a **derived agent image** (ADR-0004 layer 2). It is written under
 * `.e/agents/<name>/` on the host and `COPY`d into the image at the
 * {@link BakedProviderConfig.configDir} the adapter names - a path outside
 * `/workspace`, so `e`-generated config never lands in the Run's branch (ADR-0006).
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
  /** Absolute container path to mount {@link file} at, in the harness's config dir; outside `/workspace`. */
  mountTo: string;
  /**
   * Env relocating the harness's config dir to the mount. {@link ContainerEnv},
   * not pre-formatted argv: how a container engine spells an env entry is the
   * runtime edge's business, and `core` only knows *which* variable this
   * harness needs set to what.
   */
  env: ContainerEnv[];
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
 * A file-configured harness's provider config, ready to bake into the **derived
 * agent image** (ADR-0004 layer 2): the rendered file, the in-container dir it is
 * copied into, and the env var that points the CLI there. The adapter fills all
 * three, so the derived-image render never has to know where a harness keeps its
 * config - it copies what it is handed.
 */
export interface BakedProviderConfig {
  /** The rendered config file (Codex `config.toml`, pi `models.json`). */
  file: RenderedConfigFile;
  /** Absolute in-container config dir the file is baked into; outside `/workspace`. */
  configDir: string;
  /** Name of the env var relocating the config dir, e.g. `CODEX_HOME`. */
  configDirEnv: string;
}

/**
 * A file harness's complete provider delivery - the file-form twin of
 * {@link EnvHarnessAdapter.renderProviderEnv}: what the derived image bakes, what
 * must still reach the container at runtime, and what the run command has to
 * name. It all comes from one adapter call, so no caller reassembles a delivery
 * out of an adapter's insides.
 */
export interface FileProviderDelivery {
  /** The provider config to bake; a file harness always renders exactly one. */
  bakedConfig: BakedProviderConfig;
  /**
   * Env delivered at runtime via `--env-file`: the API key, by name only. The
   * baked file points at it through the harness's own key-by-name mechanism
   * (Codex `env_key`, pi `${VAR}` interpolation), so no secret is ever baked.
   */
  runtimeEnv: ContainerEnv[];
  /**
   * The model to name on the run command (`codex exec -m <id>`, pi `--model
   * <id>`), set only by a harness that needs it there - Codex for an `auto` pick
   * its baked config cannot select on its own, pi for every model, because it
   * selects by flag (ADR-0007). Absent means the baked config already selects it.
   */
  runtimeModel?: string;
}

/**
 * A **file-based** config adapter (Codex, pi): a {@link Provider} becomes a
 * config file baked into a derived agent image, read from a relocated config dir.
 * The API key is never baked - the file references it by env var name (Codex's
 * `env_key`) and the delivery names it as runtime env, so the secret stays a
 * runtime value (ADR-0006).
 */
export interface FileHarnessAdapter {
  kind: 'file';
  /**
   * Plans this harness's whole provider delivery in one call: the file to bake
   * and where in the image it lands, the runtime env, and any model the run
   * command must name. Every one of those is the harness's own decision - where it
   * reads config, whether it can select an `auto` model from a baked file - so a
   * new file harness is one object with one method, and the derived-image planner
   * branches on none of it. `storeEnv` is the parsed `.e/.env`, for a non-secret
   * the file bakes by value (a provider's `baseUrlEnv`); a key is always
   * referenced by name. See {@link planProviderDelivery}, the union's one fork.
   */
  planProviderDelivery(
    provider: Provider,
    storeEnv: Record<string, string>
  ): FileProviderDelivery;
  /**
   * Plans the complete MCP config-overlay delivery: merges the selected servers
   * onto the baked `baseConfig` (the exact config the derived image baked, reused
   * not re-derived; empty for a default agent with no provider) and returns the
   * merged file, the container path to mount it at, and the config-dir relocation
   * env - everything the spawn edge needs without knowing where this harness reads
   * its config. Pure - the edge writes the file, formats the mount, and appends
   * the env. **Optional** - its presence is the harness's declared file-MCP
   * capability; pi's built-in MCP support reads `mcp.json` beside the baked
   * provider file. See {@link planMcpDelivery}.
   */
  planConfigOverlay?(
    baseConfig: string,
    endpoints: McpEndpoint[],
    secretEnv?: readonly string[]
  ): ConfigOverlayDelivery;
  /**
   * The overlay is planned on **every** run, with no endpoints when there is
   * no `--mcp`: the harness needs its config on every run for more than MCP.
   * Codex does, for the settings that keep `secretEnv` (the keys a run may
   * carry) out of its shell and its shell snapshot.
   */
  overlayEveryRun?: true;
  /**
   * How a baked config already on disk stands against the one rendered now,
   * for a format that once carried a secret's value (#203): `rerender` - it
   * is what `e` rendered before, the value where the reference now is, so it
   * is replaced; `literal-key` - a hand edit that still holds a key's value,
   * kept and warned about; undefined - nothing to say. Absent: the file is
   * written if absent, as always.
   */
  bakedConfigDrift?(
    existing: string,
    rendered: string
  ): BakedConfigDrift | undefined;
}

/** See {@link FileHarnessAdapter.bakedConfigDrift}. */
export type BakedConfigDrift = 'rerender' | 'literal-key';

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
 * The provider's model is baked as the top-level `model` (ADR-0004), whether it
 * is a concrete id or the `auto/coding` alias the endpoint resolves per request;
 * {@link codexAdapter} additionally names an `auto` one on the run command
 * (`codex exec -m <id>`, ADR-0007), which a baked alias cannot stand in for.
 */
export function renderCodexConfig(provider: Provider): string {
  // A fixed provider id: `e` owns the whole file, so there is only ever one
  // custom provider and no id collision to worry about.
  const id = 'e';
  const lines: string[] = [];

  lines.push(
    `model = ${tomlBasicString(provider.model)}`,
    `model_provider = ${tomlBasicString(id)}`,
    ``,
    `[model_providers.${id}]`,
    `name = ${tomlBasicString(id)}`,
    `base_url = ${tomlBasicString(provider.baseUrl)}`,
    `env_key = ${tomlBasicString(provider.apiKeyEnv)}`,
    `wire_api = "responses"`
  );
  return (
    lines.join('\n') + '\n\n' + renderCodexSecretPolicy([provider.apiKeyEnv])
  );
}

/**
 * The two Codex settings that keep a secret out of every file and out of the
 * agent's shell (docs/research/harness-secret-delivery.md): Codex snapshots
 * the whole env into `$CODEX_HOME/shell_snapshots` by default, and hands the
 * shell every variable, whose output its rollout records. `exclude` hides the
 * named vars from the shell only; the provider and the MCP client still read
 * them. Always the file's last tables, so an overlay can extend the list.
 */
function renderCodexSecretPolicy(vars: readonly string[]): string {
  return (
    [
      `[features]`,
      `shell_snapshot = false`,
      ``,
      `[shell_environment_policy]`,
      `exclude = [${[...new Set(vars)].map(tomlBasicString).join(', ')}]`,
    ].join('\n') + '\n'
  );
}

/** Where {@link renderCodexSecretPolicy} starts in a config `e` rendered. */
const CODEX_SECRET_POLICY_START = /^\[features\]\nshell_snapshot = false\n/m;

/** The names in a rendered policy's `exclude`, which are env var names. */
function codexPolicyVars(config: string): string[] {
  const line = /^exclude = \[(.*)\]$/m.exec(config)?.[1] ?? '';
  return [...line.matchAll(/"([^"\\]*)"/g)].map(match => match[1]);
}

/** A header value that is exactly one `${NAME}` reference. */
const WHOLE_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
/** An `Authorization` value that is `Bearer ${NAME}`. */
const BEARER_REFERENCE = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** How Codex takes one MCP header: literal, whole value by name, or bearer by name. */
type CodexHeader =
  | { kind: 'literal'; value: string }
  | { kind: 'env'; name: string }
  | { kind: 'bearer'; name: string };

/**
 * Classifies a remote MCP header for Codex, whose `http_headers` are literal:
 * a `${VAR}` there would be sent as the text `${VAR}`. By name Codex takes a
 * whole value (`env_http_headers`) or `Authorization: Bearer <value>`
 * (`bearer_token_env_var`), nothing templated around a reference. Such a
 * header is refused: composing its value into a file is what this avoids.
 */
function codexHeader(
  server: string,
  header: string,
  value: string
): CodexHeader {
  if (!value.includes('${')) return { kind: 'literal', value };
  const whole = WHOLE_REFERENCE.exec(value);
  if (whole) return { kind: 'env', name: whole[1] };
  const bearer = BEARER_REFERENCE.exec(value);
  if (bearer && header.toLowerCase() === 'authorization') {
    return { kind: 'bearer', name: bearer[1] };
  }
  throw new Error(
    `MCP server "${server}": header "${header}" is "${value}", which Codex cannot read by name - it takes a secret only as the whole value ("\${VAR}") or as "Authorization: Bearer \${VAR}". Rewrite the header in its mcp.json.`
  );
}

/** Every header of every endpoint, classified for Codex. */
function codexHeaders(
  endpoint: McpEndpoint
): { header: string; as: CodexHeader }[] {
  return Object.entries(endpoint.headers ?? {}).map(([header, value]) => ({
    header,
    as: codexHeader(endpoint.name, header, value),
  }));
}

/**
 * The env var names an MCP selection's header secrets are read from, for the
 * shell `exclude`: Codex's MCP client reads them, the agent's shell must not.
 */
export function codexSecretVars(endpoints: McpEndpoint[]): string[] {
  return endpoints.flatMap(endpoint =>
    codexHeaders(endpoint).flatMap(({ as }) =>
      as.kind === 'literal' ? [] : [as.name]
    )
  );
}

/**
 * Renders the selected MCP endpoints into Codex `[mcp_servers.<name>]` TOML
 * blocks. A `url` denotes a streamable-HTTP server (Codex's only HTTP transport;
 * no `transport`/`type` key and no experimental flag are needed - verified
 * against `config.schema.json`'s `RawMcpServerConfig`) - used for container
 * sidecars reached at `http://<alias>:<port>/mcp`. A remote server's headers
 * go by name wherever they reference a secret (see {@link codexHeader}):
 * `bearer_token_env_var`, `env_http_headers`, and `http_headers` only for
 * literal values. Grounding: `docs/research/harness-secret-delivery.md`.
 */
export function renderCodexMcpServers(endpoints: McpEndpoint[]): string {
  const blocks = endpoints.map(endpoint => {
    const lines = [
      `[mcp_servers.${tomlBareKey(endpoint.name)}]`,
      `url = ${tomlBasicString(endpoint.url)}`,
    ];
    const headers = codexHeaders(endpoint);
    const bearer = headers.find(({ as }) => as.kind === 'bearer');
    if (bearer?.as.kind === 'bearer') {
      lines.push(`bearer_token_env_var = ${tomlBasicString(bearer.as.name)}`);
    }
    const table = (kind: 'env' | 'literal'): string[] =>
      headers.flatMap(({ header, as }) =>
        as.kind === kind
          ? [
              `${tomlBasicString(header)} = ${tomlBasicString(as.kind === 'env' ? as.name : as.value)}`,
            ]
          : []
      );
    const byName = table('env');
    if (byName.length > 0) {
      lines.push(`env_http_headers = { ${byName.join(', ')} }`);
    }
    const literal = table('literal');
    if (literal.length > 0) {
      lines.push(`http_headers = { ${literal.join(', ')} }`);
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
 * Where Codex reads its config in the image: `config.toml` under a config dir
 * relocated by `CODEX_HOME`, a fixed path in the non-root runtime user's home and
 * outside `/workspace`. Both of the adapter's deliveries spell the baked file's
 * home from here; the harness registry reads it too, because Codex keeps its
 * sessions under the same dir (`sessions/`, ADR-0017).
 */
const CODEX_CONFIG_DIR_ENV = 'CODEX_HOME';
export const CODEX_CONFIG_DIR = `${NODE_HOME}/.codex`;
const CODEX_CONFIG_FILE = 'config.toml';

/**
 * Codex's adapter. Codex is configured through `config.toml`, so the provider is
 * rendered into a file baked into the derived agent image; only the API key is
 * delivered at runtime, by name.
 */
export const codexAdapter: FileHarnessAdapter = {
  kind: 'file',
  planProviderDelivery(provider: Provider): FileProviderDelivery {
    return {
      bakedConfig: {
        file: {
          fileName: CODEX_CONFIG_FILE,
          content: renderCodexConfig(provider),
        },
        configDir: CODEX_CONFIG_DIR,
        configDirEnv: CODEX_CONFIG_DIR_ENV,
      },
      runtimeEnv: [{ name: provider.apiKeyEnv, fromEnv: provider.apiKeyEnv }],
      // Only an `auto` model needs naming on the command line (`codex exec -m
      // auto/coding`): the endpoint picks behind that alias per request, so the
      // baked `model` line cannot stand for it. A concrete model is selected by
      // the baked config and needs no flag (ADR-0007).
      runtimeModel:
        provider.model === 'auto/coding' ? provider.model : undefined,
    };
  },
  overlayEveryRun: true,
  planConfigOverlay(
    baseConfig: string,
    endpoints: McpEndpoint[],
    secretEnv: readonly string[] = []
  ): ConfigOverlayDelivery {
    // The policy stays the file's last tables, extended by the MCP secrets:
    // TOML allows each table once, and a default agent bakes none.
    const start = CODEX_SECRET_POLICY_START.exec(baseConfig)?.index;
    const provider =
      start === undefined ? baseConfig : baseConfig.slice(0, start);
    const vars = [
      ...(start === undefined ? [] : codexPolicyVars(baseConfig.slice(start))),
      ...secretEnv,
      ...codexSecretVars(endpoints),
    ];
    const content =
      (provider.trim() ? provider.trimEnd() + '\n\n' : '') +
      (endpoints.length > 0 ? renderCodexMcpServers(endpoints) + '\n' : '') +
      renderCodexSecretPolicy(vars);
    return {
      file: { fileName: CODEX_CONFIG_FILE, content },
      mountTo: `${CODEX_CONFIG_DIR}/${CODEX_CONFIG_FILE}`,
      env: [{ name: CODEX_CONFIG_DIR_ENV, value: CODEX_CONFIG_DIR }],
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
 * Renders MCP server endpoints into the `mcp.json` pi's built-in MCP support
 * reads from its agent dir: a top-level `mcpServers` map whose entries carry a
 * `url` (streamable HTTP) and optional `headers`. pi resolves `${NAME}` in a
 * header value from the process env, so a secret header stays a reference.
 * Grounding: pi `docs/mcp.md`, `docs/research/harness-secret-delivery.md`.
 */
export function renderPiMcpServers(endpoints: McpEndpoint[]): string {
  const mcpServers: Record<
    string,
    { url: string; headers?: Record<string, string> }
  > = {};
  for (const endpoint of endpoints) {
    const entry: { url: string; headers?: Record<string, string> } = {
      url: endpoint.url,
    };
    if (endpoint.headers && Object.keys(endpoint.headers).length > 0) {
      entry.headers = endpoint.headers;
    }
    mcpServers[endpoint.name] = entry;
  }
  return JSON.stringify({ mcpServers }, null, 2) + '\n';
}

/**
 * Maps e's wire {@link Protocol} to pi's `api` field value. Only one name differs
 * from e's: our `openai-chat` is pi's `openai-completions`.
 * Grounding: pi `docs/models.md` "Supported APIs".
 */
export function piApi(protocol: Protocol): string {
  switch (protocol) {
    case 'anthropic-messages':
      return 'anthropic-messages';
    case 'openai-chat':
      return 'openai-completions';
    case 'openai-responses':
      return 'openai-responses';
  }
}

/**
 * Renders a {@link Provider} into a pi `models.json` body: one custom provider
 * (id `e`) carrying the endpoint, the mapped `api`, a reference to the API key,
 * and the one model to select (pi selects only models **declared** here). The
 * key is `${<apiKeyEnv>}`, which pi resolves from the process env at request
 * time, so the file baked into the derived image holds no secret; a bare name
 * would be the literal key. `storeEnv` is read for `baseUrlEnv` only, a
 * non-secret. {@link planProviderDelivery} guarantees a concrete model id even
 * for `auto`. Grounding: pi `docs/models.md`,
 * `docs/research/harness-secret-delivery.md`.
 */
export function renderPiModelsJson(
  provider: Provider,
  storeEnv: Record<string, string>
): string {
  const baseUrl = provider.baseUrlEnv
    ? storeEnv[provider.baseUrlEnv]
    : provider.baseUrl;
  // By name, braces included: pi resolves `${NAME}` from the process env at
  // request time, and takes a bare `NAME` as the literal key.
  const apiKey = `\${${provider.apiKeyEnv}}`;

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

/** A pi `apiKey` that references the env by name rather than holding a value. */
const PI_KEY_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/**
 * {@link FileHarnessAdapter.bakedConfigDrift} for pi's `models.json`: before
 * keys went by name, `e` wrote the key's **value** as `apiKey`, and a Store
 * keeps that file because a rendered file is never clobbered. One that equals
 * today's render but for `apiKey` is that old render, and is re-rendered; one
 * that differs elsewhere and still holds a literal key is a hand edit to warn
 * about. A file that is not JSON is left alone.
 */
export function piModelsJsonDrift(
  existing: string,
  rendered: string
): BakedConfigDrift | undefined {
  type Shape = { providers?: Record<string, { apiKey?: unknown }> };
  let old: Shape;
  let now: Shape;
  try {
    old = JSON.parse(existing) as Shape;
    now = JSON.parse(rendered) as Shape;
  } catch {
    return undefined;
  }
  const key = old.providers?.[PI_PROVIDER_ID]?.apiKey;
  if (typeof key === 'string' && PI_KEY_REFERENCE.test(key)) return undefined;
  const withoutKey = (shape: Shape): unknown => {
    const copy = structuredClone(shape);
    const provider = copy.providers?.[PI_PROVIDER_ID];
    if (provider) delete provider.apiKey;
    return copy;
  };
  if (isDeepStrictEqual(withoutKey(old), withoutKey(now))) return 'rerender';
  return typeof key === 'string' && key !== '' ? 'literal-key' : undefined;
}

/**
 * Where pi reads its config in the image: `models.json` under a config dir
 * relocated by `PI_CODING_AGENT_DIR`, in the non-root runtime user's home and
 * outside `/workspace`. Private to the adapter, like Codex's.
 */
const PI_CONFIG_DIR_ENV = 'PI_CODING_AGENT_DIR';
const PI_CONFIG_DIR = `${NODE_HOME}/.pi/agent`;
const PI_CONFIG_FILE = 'models.json';

/**
 * pi's adapter. pi is configured through `models.json`, so the provider is
 * rendered into a file baked into the derived agent image; only the API key is
 * delivered at runtime, by name. pi's built-in MCP support reads a standard
 * `mcp.json` (`mcpServers` with `url` entries for streamable HTTP) from the same
 * config dir, so `--mcp` is delivered as a read-only overlay mounted at
 * `~/.pi/agent/mcp.json`.
 */
export const piAdapter: FileHarnessAdapter = {
  kind: 'file',
  bakedConfigDrift: piModelsJsonDrift,
  planProviderDelivery(
    provider: Provider,
    storeEnv: Record<string, string>
  ): FileProviderDelivery {
    return {
      bakedConfig: {
        file: {
          fileName: PI_CONFIG_FILE,
          content: renderPiModelsJson(provider, storeEnv),
        },
        configDir: PI_CONFIG_DIR,
        configDirEnv: PI_CONFIG_DIR_ENV,
      },
      runtimeEnv: [{ name: provider.apiKeyEnv, fromEnv: provider.apiKeyEnv }],
      // pi selects a model by flag and only from what `models.json` declares, so
      // every model is both baked and named on the command line (ADR-0007
      // staleness applies: a newly-shipped `auto` pick lands with the next
      // spawn's rebuild, and not under `--no-rebuild`).
      runtimeModel: provider.model,
    };
  },
  planConfigOverlay(
    _baseConfig: string,
    endpoints: McpEndpoint[]
  ): ConfigOverlayDelivery {
    return {
      file: {
        // pi's built-in MCP reads this file; the baked models.json
        // provider config is untouched (the overlay mounts a sibling file).
        fileName: 'mcp.json',
        content: renderPiMcpServers(endpoints),
      },
      // Mount next to models.json in pi's config dir. No relocation env: pi's
      // provider models.json stays exactly where it baked.
      mountTo: `${PI_CONFIG_DIR}/mcp.json`,
      env: [],
    };
  },
};

/**
 * The fixed provider id `e` writes into opencode's `opencode.json`. `e` owns the
 * whole file, so there is only ever one custom provider. Shared with opencode's
 * `buildCommand`, which selects `<id>/<model>` via `-m`.
 */
export const OPENCODE_PROVIDER_ID = 'e';

/**
 * Maps e's wire {@link Protocol} to the AI SDK package opencode loads for a
 * custom provider. All three are bundled with opencode, so nothing is installed
 * at runtime. Grounding: opencode `packages/opencode/src/provider/provider.ts`
 * (`BUNDLED_PROVIDERS`), `docs/research/harness-cli-facts.md`.
 */
export function opencodeNpm(protocol: Protocol): string {
  switch (protocol) {
    case 'openai-chat':
      return '@ai-sdk/openai-compatible';
    case 'openai-responses':
      return '@ai-sdk/openai';
    case 'anthropic-messages':
      return '@ai-sdk/anthropic';
  }
}

/**
 * Renders a {@link Provider} into an opencode `opencode.json` body: one custom
 * provider (id `e`) with the protocol's AI SDK package, the endpoint, and the one
 * model, selected as the top-level `model` (and `small_model`, so titles and
 * summaries never reach for a provider the run has no key for). The key is
 * referenced by name through opencode's `{env:VAR}` substitution, so no secret is
 * baked. A `baseUrlEnv` is resolved from the store at bake time, like pi's; the
 * literal `baseUrl` is the fallback. Grounding: opencode
 * `packages/opencode/src/config/variable.ts`, `config.mdx`.
 */
export function renderOpencodeConfig(
  provider: Provider,
  storeEnv: Record<string, string>
): string {
  const baseURL =
    (provider.baseUrlEnv && storeEnv[provider.baseUrlEnv]) || provider.baseUrl;
  const model = `${OPENCODE_PROVIDER_ID}/${provider.model}`;
  const config = {
    $schema: 'https://opencode.ai/config.json',
    model,
    small_model: model,
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm: opencodeNpm(provider.protocol),
        name: OPENCODE_PROVIDER_ID,
        options: { baseURL, apiKey: `{env:${provider.apiKeyEnv}}` },
        models: { [provider.model]: { name: provider.model } },
      },
    },
  };
  return JSON.stringify(config, null, 2) + '\n';
}

/**
 * Where opencode reads its config in the image: `opencode.json` under the dir
 * `OPENCODE_CONFIG_DIR` names, outside `/workspace`. That dir is merged after the
 * project's `opencode.json`, so a workspace file cannot re-point the provider.
 * opencode writes into it at runtime (a `.gitignore`, a plugin install), which
 * the derived image's chown allows.
 */
const OPENCODE_CONFIG_DIR_ENV = 'OPENCODE_CONFIG_DIR';
const OPENCODE_CONFIG_DIR = `${NODE_HOME}/.config/opencode`;
const OPENCODE_CONFIG_FILE = 'opencode.json';

/**
 * Where opencode's MCP overlay mounts: a file of its own, outside `/workspace`
 * and outside the baked config dir, named by `OPENCODE_CONFIG`. opencode
 * deep-merges it after the global config and before the project's and the
 * config dir's, so the baked provider stays exactly as it baked and nothing is
 * mounted into a dir opencode writes to at runtime.
 */
const OPENCODE_CONFIG_ENV = 'OPENCODE_CONFIG';
const OPENCODE_MCP_FILE = 'opencode-mcp.json';
const OPENCODE_MCP_PATH = `/run/e/${OPENCODE_MCP_FILE}`;

/**
 * Renders MCP endpoints into an opencode config holding only `mcp`: each a
 * `remote` (streamable HTTP) server, enabled, with OAuth off - a headless run
 * has nobody to finish a flow, and a server that authenticates by header
 * needs none. opencode substitutes only `{env:VAR}` (textually, before it
 * parses the file) and sends `${VAR}` as written, so every `${VAR}` in a
 * header becomes `{env:VAR}`: the secret stays a reference, never a value.
 * An unset var becomes `""` in opencode; e's `requiredEnv` fails loud first.
 * Grounding: `docs/research/harness-secret-delivery.md`.
 */
export function renderOpencodeMcp(endpoints: McpEndpoint[]): string {
  const mcp: Record<string, Record<string, unknown>> = {};
  for (const endpoint of endpoints) {
    mcp[endpoint.name] = {
      type: 'remote',
      url: endpoint.url,
      enabled: true,
      oauth: false,
      ...(endpoint.headers && Object.keys(endpoint.headers).length > 0
        ? {
            headers: Object.fromEntries(
              Object.entries(endpoint.headers).map(([header, value]) => [
                header,
                value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '{env:$1}'),
              ])
            ),
          }
        : {}),
    };
  }
  return (
    JSON.stringify(
      { $schema: 'https://opencode.ai/config.json', mcp },
      null,
      2
    ) + '\n'
  );
}

/**
 * opencode's adapter. opencode is configured through `opencode.json`, so the
 * provider is rendered into a file baked into the derived agent image; only the
 * API key is delivered at runtime, by name. The model is always named on the run
 * command (`-m e/<model>`) as well, so the pick never depends on config merge
 * order. `--mcp` is delivered as its own config file, {@link renderOpencodeMcp}.
 */
export const opencodeAdapter: FileHarnessAdapter = {
  kind: 'file',
  planProviderDelivery(
    provider: Provider,
    storeEnv: Record<string, string>
  ): FileProviderDelivery {
    return {
      bakedConfig: {
        file: {
          fileName: OPENCODE_CONFIG_FILE,
          content: renderOpencodeConfig(provider, storeEnv),
        },
        configDir: OPENCODE_CONFIG_DIR,
        configDirEnv: OPENCODE_CONFIG_DIR_ENV,
      },
      runtimeEnv: [{ name: provider.apiKeyEnv, fromEnv: provider.apiKeyEnv }],
      runtimeModel: `${OPENCODE_PROVIDER_ID}/${provider.model}`,
    };
  },
  planConfigOverlay(
    _baseConfig: string,
    endpoints: McpEndpoint[]
  ): ConfigOverlayDelivery {
    return {
      file: {
        fileName: OPENCODE_MCP_FILE,
        content: renderOpencodeMcp(endpoints),
      },
      mountTo: OPENCODE_MCP_PATH,
      env: [{ name: OPENCODE_CONFIG_ENV, value: OPENCODE_MCP_PATH }],
    };
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
  harness: HarnessProtocols
): void {
  if (!provider) return;
  if (!harness.protocols.includes(provider.protocol)) {
    throw new Error(
      `Harness "${harness.name}" does not speak protocol "${provider.protocol}"; ` +
        `it speaks: ${harness.protocols.join(', ')}. ` +
        `Point this agent at a compatible endpoint or use a different harness.`
    );
  }
}

/**
 * Renders {@link ContainerEnv} entries into `.env` file content (one `NAME=value`
 * line each), delivered to the container via `--env-file` so no value lands on
 * argv. Constructed once with the parsed `.e/.env` resolver and reused for every
 * credential env-file a spawn writes - the provider's and each MCP server's - so
 * the secret resolution and its single fail-loud live in one place (ADR-0006/0008).
 */
export class EnvFileRenderer {
  constructor(private readonly resolve: (name: string) => string | undefined) {}

  /**
   * Renders `entries` to env-file content. A `value` entry inlines its literal; a
   * `fromEnv` entry is resolved by name, and a missing or empty value is a hard
   * error. `subject` names who needs the key (e.g. `Provider API key`, `MCP server
   * "everything"`) so the one message stays specific - running with an empty
   * credential would otherwise fail opaquely deep inside the harness.
   */
  render(entries: ContainerEnv[], subject: string): string {
    const lines = entries.map(entry => {
      if ('value' in entry) return `${entry.name}=${entry.value}`;
      const value = this.resolve(entry.fromEnv);
      if (value === undefined || value === '') {
        throw new Error(
          `${subject} env "${entry.fromEnv}" is not set in .e/.env. ` +
            `Add "${entry.fromEnv}=<value>" there - its value is injected at runtime, never baked into an image.`
        );
      }
      return `${entry.name}=${value}`;
    });
    log.debug(`Rendered ${lines.length} env lines for ${subject}`);
    return lines.join('\n') + '\n';
  }
}
