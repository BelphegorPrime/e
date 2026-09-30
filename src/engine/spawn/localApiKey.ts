/**
 * The OmniRoute endpoint-key handshake for `e spawn`, kept pure so the
 * decision and the `.e/.env` edit are testable without a terminal.
 *
 * A fresh local stack has no endpoint API key yet: the agent's provider key
 * is empty or still the generated initial password. Only an agent whose
 * provider actually points at the local OmniRoute needs that key; a hosted
 * provider (a real Anthropic or OpenAI key) must never be prompted for, nor
 * have its key overwritten.
 */

import { OMNIROUTE_PORT } from '../../shared/constants.js';

/** The provider facts the handshake looks at. */
export interface LocalStackProvider {
  baseUrl: string;
  apiKeyEnv: string;
}

/** True when the provider's base URL is the local OmniRoute gateway. */
export function providerTargetsLocalStack(
  provider: LocalStackProvider
): boolean {
  try {
    const url = new URL(provider.baseUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return local && url.port === String(OMNIROUTE_PORT);
  } catch {
    return false;
  }
}

/**
 * True when the run must ask for an OmniRoute endpoint key first: the stack
 * is running, the provider targets it, and the configured key is missing,
 * still the initial password, or rejected by OmniRoute (`accepted` false).
 */
export function needsLocalApiKey(params: {
  stackPresent: boolean;
  provider: LocalStackProvider | undefined;
  configuredKey: string;
  stackPassword: string;
  accepted: boolean;
}): boolean {
  const { stackPresent, provider, configuredKey, stackPassword, accepted } =
    params;
  if (!stackPresent || !provider || !providerTargetsLocalStack(provider)) {
    return false;
  }
  if (configuredKey === '' || configuredKey === stackPassword) return true;
  return !accepted;
}

/**
 * Sets `key=value` in dotenv content: replaces the first `key=...` line, or
 * appends one. The value is inserted literally (no `$`-pattern expansion), so
 * a key containing `$&` or `$1` survives.
 */
export function upsertEnvValue(
  content: string,
  key: string,
  value: string
): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(content)) return content.replace(pattern, () => line);
  const head =
    content === '' || content.endsWith('\n') ? content : `${content}\n`;
  return `${head}${line}\n`;
}

/** Why automatic key creation did not happen; the caller falls back to asking. */
export class LocalApiKeyError extends Error {}

/**
 * A signed-in OmniRoute dashboard session: the `auth_token` cookie the key
 * management API takes. It stays in memory, host-side; the JWT lives for 30
 * days, so one sign-in covers a run from mint to delete.
 */
export interface LocalStackSession {
  baseUrl: string;
  token: string;
  fetchImpl: typeof fetch;
}

/** The prefix of every per-run key's name, which the sweep selects on. */
export const RUN_KEY_PREFIX = 'e-run-';

/**
 * Signs in with the management password (`OMNIROUTE_INITIAL_PASSWORD`, the
 * same login the bootstrap script uses). Throws {@link LocalApiKeyError}
 * when OmniRoute rejects it - the usual cause: the omniroute-data volume was
 * set up with another password.
 */
export async function signInLocalStack(params: {
  baseUrl: string;
  password: string;
  fetchImpl?: typeof fetch;
}): Promise<LocalStackSession> {
  const { baseUrl, password, fetchImpl = fetch } = params;
  const login = await fetchImpl(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const token = authTokenFrom(login.headers);
  if (!login.ok || !token) {
    throw new LocalApiKeyError(
      `OmniRoute rejected OMNIROUTE_INITIAL_PASSWORD (HTTP ${login.status})`
    );
  }
  return { baseUrl, token, fetchImpl };
}

/** One management call with the session cookie. Never sends an `Origin`, which OmniRoute's CSRF gate would refuse. */
function manage(
  session: LocalStackSession,
  method: string,
  pathname: string,
  body?: unknown
): Promise<Response> {
  return session.fetchImpl(`${session.baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      cookie: `auth_token=${session.token}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** A key as the create call returned it: the DB id deletes it, the key authenticates. */
export interface MintedKey {
  id: string;
  key: string;
  expiresAt?: string;
}

/**
 * Creates an endpoint key named `name`, expiring at `expiresAt` when given.
 * The id comes back only here and in the list, so a caller that must delete
 * the key keeps it. An image older than v3.8.51 drops `expiresAt` from the
 * create body without an error, which its response shows; the expiry is then
 * set by `PATCH`, and a key it cannot be set on is deleted rather than handed
 * out without one. No `scopes` are sent: the key holds only `self:usage`, so
 * it cannot list, mint or delete keys itself.
 */
export async function mintLocalApiKey(
  session: LocalStackSession,
  params: { name: string; expiresAt?: string }
): Promise<MintedKey> {
  const { name, expiresAt } = params;
  const created = await manage(session, 'POST', '/api/keys', {
    name,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });
  if (!created.ok) {
    throw new LocalApiKeyError(
      `OmniRoute could not create an API key (HTTP ${created.status})`
    );
  }
  const body = (await created.json()) as {
    key?: unknown;
    id?: unknown;
    expiresAt?: unknown;
  };
  if (typeof body.key !== 'string' || body.key === '') {
    throw new LocalApiKeyError('OmniRoute returned no API key');
  }
  // Every release since v1.0.4 returns the id; without it no key can be deleted.
  if (typeof body.id !== 'string' || body.id === '') {
    throw new LocalApiKeyError('OmniRoute returned no key id');
  }
  if (expiresAt === undefined) return { id: body.id, key: body.key };
  const minted = { id: body.id, key: body.key, expiresAt };
  if (body.expiresAt === expiresAt) return minted;
  const patched = await manage(session, 'PATCH', `/api/keys/${body.id}`, {
    expiresAt,
  });
  if (!patched.ok) {
    await deleteLocalApiKey(session, body.id).catch(() => undefined);
    throw new LocalApiKeyError(
      `OmniRoute did not take the key's expiry (HTTP ${patched.status}); upgrade the omniroute image`
    );
  }
  return minted;
}

/** A key as the list shows it: never the key itself, which the list masks. */
export interface ListedKey {
  id: string;
  name: string;
  createdAt?: string;
  expiresAt?: string | null;
}

/** Every key in OmniRoute, oldest first. The list has no server-side filter. */
export async function listLocalApiKeys(
  session: LocalStackSession
): Promise<ListedKey[]> {
  const response = await manage(session, 'GET', '/api/keys');
  if (!response.ok) {
    throw new LocalApiKeyError(
      `OmniRoute could not list API keys (HTTP ${response.status})`
    );
  }
  const body = (await response.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys)) return [];
  return body.keys.flatMap((raw: unknown): ListedKey[] => {
    const k = raw as Record<string, unknown>;
    if (typeof k.id !== 'string' || typeof k.name !== 'string') return [];
    return [
      {
        id: k.id,
        name: k.name,
        ...(typeof k.createdAt === 'string' ? { createdAt: k.createdAt } : {}),
        ...(typeof k.expiresAt === 'string' || k.expiresAt === null
          ? { expiresAt: k.expiresAt }
          : {}),
      },
    ];
  });
}

/** Deletes a key by id. A 404 counts as done: the key is already gone. */
export async function deleteLocalApiKey(
  session: LocalStackSession,
  id: string
): Promise<void> {
  const response = await manage(
    session,
    'DELETE',
    `/api/keys/${encodeURIComponent(id)}`
  );
  if (!response.ok && response.status !== 404) {
    throw new LocalApiKeyError(
      `OmniRoute could not delete API key ${id} (HTTP ${response.status})`
    );
  }
}

/**
 * The per-run keys a sweep deletes: named `e-run-*` and past their expiry,
 * or, for one without an expiry, created longer than `maxAgeMs` ago - the
 * run cap, which no live run outlasts. Never the prefix alone: a concurrent
 * run's live key has it too, and a key with an expiry is trusted to it, so a
 * run with a longer cap keeps its key. A key whose dates do not parse is
 * left alone.
 */
export function staleRunKeys(
  keys: readonly ListedKey[],
  now: Date,
  maxAgeMs: number
): ListedKey[] {
  const at = (value: string | null | undefined): number =>
    typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return keys.filter(key => {
    if (!key.name.startsWith(RUN_KEY_PREFIX)) return false;
    if (typeof key.expiresAt === 'string') {
      const expires = at(key.expiresAt);
      return !Number.isNaN(expires) && expires <= now.getTime();
    }
    const created = at(key.createdAt);
    return !Number.isNaN(created) && created <= now.getTime() - maxAgeMs;
  });
}

/**
 * Creates an OmniRoute endpoint API key the way the dashboard does: sign in
 * with the management password, then `POST /api/keys`. Returns the new key.
 *
 * Throws {@link LocalApiKeyError} when OmniRoute rejects the password or
 * does not return a key, so the caller can fall back to a manual prompt.
 */
export async function createLocalApiKey(params: {
  baseUrl: string;
  password: string;
  name: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const session = await signInLocalStack(params);
  return (await mintLocalApiKey(session, { name: params.name })).key;
}

/** The `auth_token` cookie value from a login response, if any. */
function authTokenFrom(headers: Headers): string | undefined {
  const cookies =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie') ?? ''];
  for (const cookie of cookies) {
    const match = /^auth_token=([^;]+)/.exec(cookie.trim());
    if (match) return match[1];
  }
  return undefined;
}
