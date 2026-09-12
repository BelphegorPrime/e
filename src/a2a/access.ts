/**
 * Who may reach `e serve`'s A2A endpoint (ADR-0015), decided purely from the
 * bind host and the configured token. ADR-0010/0014 keep `serve` on loopback
 * without auth because anyone there could run `e spawn` anyway; an A2A
 * endpoint is a *start-a-run* path, so the same reasoning holds on loopback
 * and stops holding the moment `--host` opens `serve` to a network. Beyond
 * loopback the endpoint needs a bearer token (`E_A2A_TOKEN`) or stays off.
 */

export interface A2aAccessInput {
  /** The interface `serve` binds (`--host`). */
  host: string;
  /** `E_A2A_TOKEN`, when set. */
  token?: string;
}

export type A2aAccess =
  | { enabled: true; requireBearer: boolean; token?: string }
  | { enabled: false; reason: string };

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/** The decision: on loopback the token is optional (required when set); elsewhere it is mandatory. */
export function a2aAccess(input: A2aAccessInput): A2aAccess {
  const token = input.token?.trim() || undefined;
  if (isLoopbackHost(input.host)) {
    return token === undefined
      ? { enabled: true, requireBearer: false }
      : { enabled: true, requireBearer: true, token };
  }
  if (token === undefined) {
    return {
      enabled: false,
      reason: `serve is bound to ${input.host}, beyond loopback; set E_A2A_TOKEN to expose the A2A endpoint with bearer auth, or bind 127.0.0.1.`,
    };
  }
  return { enabled: true, requireBearer: true, token };
}

/** True when `authorization` carries the expected bearer token (constant-time compare). */
export function bearerMatches(
  authorization: string | undefined,
  token: string
): boolean {
  if (authorization === undefined) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return false;
  const presented = match[1].trim();
  if (presented.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= presented.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}
