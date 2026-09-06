import { useCallback, useEffect, useState } from 'react';
import { GitBranch } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** One run as served by the BFF `/api/runs` index (branch-backed, ADR-0010). */
interface Run {
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

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; runs: Run[] };

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function StatusBadge({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      className={cn(
        'rounded-full border px-2 py-0.5 text-xs',
        on
          ? 'border-border bg-muted text-foreground'
          : 'border-dashed border-border text-muted-foreground'
      )}
    >
      {label}
    </span>
  );
}

export function RunsPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

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

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <PageHeader title="Runs" description="e - run history" />
      {state.status === 'loading' && (
        <div className="space-y-3">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      )}
      {state.status === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Could not load runs: {state.message}
          </p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      )}
      {state.status === 'ready' && state.runs.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center">
          <div className="flex size-12 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <GitBranch className="size-6" />
          </div>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            No runs yet. Start one with <code>e spawn</code> and it will show up
            here.
          </p>
        </div>
      )}
      {state.status === 'ready' && state.runs.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border">
          <ul className="divide-y divide-border">
            {state.runs.map(run => (
              <li
                key={run.branch}
                className="flex items-center justify-between gap-4 bg-background p-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {run.subject || run.slug}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {run.agent}/{run.slug}-{run.counter}
                    <span className="mx-1.5 text-border">|</span>
                    {formatDate(run.committerDate)}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                    {run.branch}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <StatusBadge label="local" on={run.local} />
                  <StatusBadge label="pushed" on={run.pushed} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
