import { useCallback, useEffect, useState } from 'react';

/**
 * Client for the egress container API (ADR-0012), reached through the BFF's
 * `/api/egress/*` proxy. The wire types mirror `src/egress/types.ts`.
 */

/** One rollup per domain from `GET /logs/squashed`. */
export interface SquashedEntry {
  domain: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

/** Body of `GET /blacklist/domains`. */
export interface BlacklistDomainsResponse {
  domains: string[];
}

export type EgressLoadState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T };

/** Reads the server's `{ error }` body for a failed response, else the HTTP status. */
async function failureMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // Not JSON: fall through to the status line.
  }
  return `HTTP ${response.status}`;
}

/**
 * Loads one egress resource and exposes `[state, reload]`, the same shape as
 * `useRuns` in `bff.ts`, so a 503 "Egress API not configured" or a 502 from a
 * stopped container renders as an error instead of an empty table.
 */
function useEgressResource<T>(path: string): [EgressLoadState<T>, () => void] {
  const [state, setState] = useState<EgressLoadState<T>>({
    status: 'loading',
  });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(await failureMessage(response));
      }
      setState({ status: 'ready', data: (await response.json()) as T });
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  return [state, load];
}

export function useSquashedEgressLogs(): [
  EgressLoadState<SquashedEntry[]>,
  () => void,
] {
  return useEgressResource<SquashedEntry[]>('/api/egress/logs/squashed');
}

export function useBlacklist(): [
  EgressLoadState<BlacklistDomainsResponse>,
  () => void,
] {
  return useEgressResource<BlacklistDomainsResponse>(
    '/api/egress/blacklist/domains'
  );
}

/** Sends a blacklist mutation; resolves on `{ status: 'ok' }`, throws the server's error otherwise. */
async function mutateBlacklist(path: string, init: RequestInit): Promise<void> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new Error(await failureMessage(response));
  }
}

export function addBlacklistDomain(domain: string): Promise<void> {
  return mutateBlacklist('/api/egress/blacklist/domains', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain }),
  });
}

export function removeBlacklistDomain(domain: string): Promise<void> {
  return mutateBlacklist(
    `/api/egress/blacklist/domains/${encodeURIComponent(domain)}`,
    { method: 'DELETE' }
  );
}
