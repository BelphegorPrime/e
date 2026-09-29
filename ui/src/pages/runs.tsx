import { GitBranch } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useRuns, formatDate, type Run } from '@/lib/bff';

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

/** The ledger state, and a gated run's verdict, as one short label. */
function stateLabel(run: Run): string | undefined {
  if (!run.state) return undefined;
  if (run.state !== 'done') return run.state;
  if (run.outcome) return run.outcome;
  return run.exitCode === 0 ? 'done' : `exit ${run.exitCode ?? '?'}`;
}

export function RunsPage() {
  const [state, load] = useRuns();

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
      {state.status === 'ready' && state.pending.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-dashed border-border">
          <ul className="divide-y divide-border">
            {state.pending.map(run => (
              <li
                key={run.id}
                className="flex items-center justify-between gap-4 bg-muted/30 p-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {run.trigger ?? run.agent}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {run.agent}
                    {run.enqueuedAt && (
                      <>
                        <span className="mx-1.5 text-border">|</span>
                        {formatDate(run.enqueuedAt)}
                      </>
                    )}
                  </p>
                  {run.key && (
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                      {run.key}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <StatusBadge label={run.state} on />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {state.status === 'ready' &&
        state.runs.length === 0 &&
        state.pending.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center">
            <div className="flex size-12 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <GitBranch className="size-6" />
            </div>
            <p className="mx-auto max-w-sm text-sm text-muted-foreground">
              No runs yet. Start one with <code>e spawn</code> and it will show
              up here.
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
                  {stateLabel(run) && (
                    <StatusBadge label={stateLabel(run) as string} on />
                  )}
                  {run.gateRemovals && run.gateRemovals.files > 0 && (
                    <StatusBadge
                      label={`gate weakened: ${run.gateRemovals.files} files, -${run.gateRemovals.lines} lines`}
                      on
                    />
                  )}
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
