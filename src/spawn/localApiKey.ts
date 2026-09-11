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

import { OMNIROUTE_PORT } from '../constants.js';

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
 * Creates an OmniRoute endpoint API key the way the dashboard does: sign in
 * with the management password (`OMNIROUTE_INITIAL_PASSWORD`, the same login
 * the bootstrap script uses), then `POST /api/keys`. Returns the new key.
 *
 * Throws {@link LocalApiKeyError} when OmniRoute rejects the password (the
 * usual cause: the omniroute-data volume was set up with an older `.e/.env`)
 * or does not return a key, so the caller can fall back to a manual prompt.
 */
export async function createLocalApiKey(params: {
  baseUrl: string;
  password: string;
  name: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const { baseUrl, password, name, fetchImpl = fetch } = params;
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
  const created = await fetchImpl(`${baseUrl}/api/keys`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `auth_token=${token}`,
    },
    body: JSON.stringify({ name }),
  });
  if (!created.ok) {
    throw new LocalApiKeyError(
      `OmniRoute could not create an API key (HTTP ${created.status})`
    );
  }
  const body = (await created.json()) as { key?: unknown };
  if (typeof body.key !== 'string' || body.key === '') {
    throw new LocalApiKeyError('OmniRoute returned no API key');
  }
  return body.key;
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
