import type { Provider } from '../harness/adapter.js';

interface ModelsResponse {
  data?: Array<{ id?: unknown }>;
}

export interface ModelFetch {
  (url: string, init?: RequestInit): Promise<Response>;
}

/**
 * Resolves `auto` to a model the provider actually advertises. `auto` is not
 * sent to the harness: Pi bakes the selected id into models.json, and OmniRoute
 * rejects `auto` when it reaches its OpenAI-compatible API.
 */
export async function resolveProviderModel(
  provider: Provider,
  storeEnv: Record<string, string>,
  fetchImpl: ModelFetch = fetch
): Promise<string> {
  if (provider.model !== 'auto') return provider.model;

  const baseUrl = provider.baseUrlEnv
    ? storeEnv[provider.baseUrlEnv] || provider.baseUrl
    : provider.baseUrl;
  const modelsUrl = `${baseUrl.replace(/\/$/, '')}/models`;
  const key = storeEnv[provider.apiKeyEnv];

  let response: Response;
  try {
    response = await fetchImpl(modelsUrl, {
      headers: key ? { Authorization: `Bearer ${key}` } : undefined,
    });
  } catch (error) {
    throw new Error(
      `Could not reach provider models endpoint ${modelsUrl}: ${(error as Error).message}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Provider models endpoint ${modelsUrl} returned HTTP ${response.status}. ` +
        `Cannot resolve model auto.`
    );
  }

  let payload: ModelsResponse;
  try {
    payload = (await response.json()) as ModelsResponse;
  } catch {
    throw new Error(`Provider models endpoint ${modelsUrl} returned invalid JSON.`);
  }

  const ids = (payload.data ?? [])
    .map(model => (typeof model.id === 'string' ? model.id : undefined))
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) {
    throw new Error(
      `Provider models endpoint ${modelsUrl} returned no usable models; cannot resolve model auto.`
    );
  }

  // OmniRoute's endpoint ordering is its routing policy. Do not invent a
  // second ranking in e: use the gateway's first advertised concrete model.
  return ids[0];
}
