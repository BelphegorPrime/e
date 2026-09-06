import { useCallback, useEffect, useState } from 'react';

/** One run as served by the BFF `/api/runs` index (branch-backed, ADR-0010). */
export interface Run {
  branch: string;
  agent: string;
  slug: string;
  counter: number;
  sha: string;
  committerDate: string;
  subject: string;
  local: boolean;
  pushed: boolean;
}

interface RunsResponse {
  runs: Run[];
}

export type RunsLoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; runs: Run[] };

/**
 * Fetches the branch-backed runs index from the BFF. The runs index is the
 * single source of truth for every live slice of the UI today (ADR-0010): the
 * dashboard derives its stats, agents derive their inventory, and activity
 * derives its event stream, all from the same `/api/runs` payload.
 */
export function useRuns(): [RunsLoadState, () => void] {
  const [state, setState] = useState<RunsLoadState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const response = await fetch('/api/runs');
      if (!response.ok) {
        throw new Error(`BFF returned HTTP ${response.status}`);
      }
      const body = (await response.json()) as RunsResponse;
      setState({ status: 'ready', runs: body.runs });
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return [state, load];
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
