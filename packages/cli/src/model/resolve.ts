import type { Protocol, Provider } from '../harness/adapter';
import { chooseModel, Tier } from './preferences';
import { ModelDataEntry, writeModelsJson } from '../store';

/**
 * Resolving an Agent's model at spawn (ADR-0007). A concrete model is used as-is
 * (and baked, per ADR-0004); an `auto` model is resolved here against the
 * provider's live model list and delivered at runtime. The HTTP call lives behind
 * {@link ModelsLister} so the decision is testable with a faked endpoint.
 */

/** The result of resolving a Provider's model to a concrete id. */
export interface ResolvedModel {
  /** The concrete model id the run should use. */
  model: string;
  /**
   * Whether the id came from `auto` resolution (delivered at runtime) rather than
   * a concrete declaration (baked). The delivery path branches on this.
   */
  fromAuto: boolean;
}

/** Lists the model ids a provider's endpoint advertises. Faked in tests. */
export interface ModelsLister {
  list(provider: Provider): Promise<string[]>;
}

/**
 * Builds the model-list URL for a base, normalising the version segment: a base
 * that already ends in `/v1` gets `/models` appended, otherwise `/v1/models` —
 * so both `https://host` and `https://host/v1` resolve to `.../v1/models`. Both
 * the OpenAI and Anthropic model-list endpoints live at `/v1/models`; a protocol
 * that ever diverges would grow its own construction.
 */
export function modelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
}

/**
 * Extracts model ids from a model-list response, purely. Both OpenAI and
 * Anthropic return `{ data: [{ id }] }`; anything that doesn't fit that shape is
 * skipped rather than throwing, so a surprising body degrades to "no models"
 * (which callers treat as no match) instead of a crash.
 */
export function parseModelIds(
  body: unknown,
  props: { root: string | undefined }
): string[] {
  const data = (body as { data?: ModelDataEntry[] } | null)?.data;

  if (!Array.isArray(data)) {
    return [];
  }

  writeModelsJson(data, props.root);

  return data
    .map(entry =>
      entry && typeof entry === 'object' && typeof entry.id === 'string'
        ? entry.id
        : undefined
    )
    .filter((id): id is string => id !== undefined);
}

/**
 * Resolves a Provider's model to a concrete id (ADR-0007). A non-`auto` model is
 * returned untouched. For `auto`, the endpoint's model list is fetched and the
 * best available model for `tier` is chosen from the curated preference list; if
 * the endpoint is unreachable, the Provider's `defaultModel` is used, or — absent
 * that — a clear error is thrown. A `defaultModel` also backstops "reachable but
 * nothing preferred is available" (handled inside {@link chooseModel}).
 */
export async function resolveProviderModel(
  provider: Provider,
  tier: Tier,
  lister: ModelsLister
): Promise<ResolvedModel> {
  if (provider.model !== 'auto') {
    return { model: provider.model, fromAuto: false };
  }

  let available: string[];
  try {
    available = await lister.list(provider);
  } catch (err) {
    if (provider.defaultModel) {
      return { model: provider.defaultModel, fromAuto: true };
    }
    throw new Error(
      `Could not resolve an "auto" model: the model list at ${provider.baseUrl} was unreachable ` +
        `(${(err as Error).message}), and no defaultModel is set on the provider.`,
      {
        cause: err,
      }
    );
  }

  console.log({ provider });

  return {
    model: chooseModel(
      available,
      provider.protocol,
      tier,
      provider.defaultModel
    ),
    fromAuto: true,
  };
}

/**
 * The real {@link ModelsLister}: fetches `/v1/models` and returns the advertised
 * ids. Auth is per-protocol — `Authorization: Bearer` for OpenAI-shaped
 * endpoints, `x-api-key` + `anthropic-version` for Anthropic. The API key is
 * resolved by name from `.e/.env` via the injected `resolveKey`, never held here.
 * Only the protocols `e` has adapters for are wired; others throw.
 */
export class HttpModelsLister implements ModelsLister {
  constructor(
    private readonly resolveKey: (envName: string) => string | undefined,
    private root: string | undefined
  ) {}

  async list(provider: Provider): Promise<string[]> {
    const key = this.resolveKey(provider.apiKeyEnv);
    if (!key) {
      throw new Error(
        `Provider API key env "${provider.apiKeyEnv}" is not set in .e/.env, so the model list cannot be fetched.`
      );
    }

    const headers = authHeaders(provider.protocol, key);
    if (!headers) {
      throw new Error(
        `Automatic model resolution is not supported for protocol "${provider.protocol}" yet; ` +
          `set a concrete model or a defaultModel.`
      );
    }

    const baseUrl =
      (provider.baseUrlEnv
        ? this.resolveKey(provider.baseUrlEnv)
        : undefined) || provider.baseUrl;

    const res = await fetch(modelsUrl(baseUrl), { headers });

    if (!res.ok) {
      throw new Error(`model list request failed with HTTP ${res.status}`);
    }

    return parseModelIds(await res.json(), { root: this.root });
  }
}

/** Per-protocol auth headers for a model-list request, or undefined if unsupported. */
function authHeaders(
  protocol: Protocol,
  key: string
): Record<string, string> | undefined {
  switch (protocol) {
    case 'openai-chat':
    case 'openai-responses':
      return { Authorization: `Bearer ${key}` };
    case 'anthropic-messages':
      return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  }
}
