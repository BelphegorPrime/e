import { useCallback, useEffect, useState } from 'react';

/** Where a run stands in `e serve`'s ledger (ADR-0016 section 6); absent for a run the ledger no longer holds. */
export type RunState =
  'claimed' | 'running' | 'done' | 'failed' | 'interrupted';

/** One run as served by the BFF `/api/runs` index (branch-backed, ADR-0010), with its ledger state while live. */
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
  state?: RunState;
  exitCode?: number;
  /** A gated run's verdict: `verified`, `exhausted`, `aborted`. */
  outcome?: string;
  reason?: string;
  /** Lines the branch removed under `verify.guards` (ADR-0016 section 11). */
  gateRemovals?: { files: number; lines: number };
}

/** A triggered request waiting for a slot, or claimed and not yet on a branch. */
export interface PendingRun {
  branch: null;
  state: 'queued' | 'claimed';
  id: string;
  agent: string;
  trigger?: string;
  key?: string;
  enqueuedAt?: string;
}

interface RunsResponse {
  runs: Array<Run | PendingRun>;
}

export type RunsLoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; runs: Run[]; pending: PendingRun[] };

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
      // One list from the BFF; every page but the runs page wants branches only.
      setState({
        status: 'ready',
        runs: body.runs.filter((run): run is Run => run.branch !== null),
        pending: body.runs.filter(
          (run): run is PendingRun => run.branch === null
        ),
      });
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
