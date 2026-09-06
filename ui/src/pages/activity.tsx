import { Activity, GitCommit } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useRuns, formatDate } from '@/lib/bff';
import type { Run } from '@/lib/bff';

function EventRow({ run }: { run: Run }) {
  return (
    <li className="flex items-start gap-3 p-4">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground">
        <GitCommit className="size-3.5" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {run.subject || run.slug}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {run.agent}/{run.slug}-{run.counter}
          <span className="mx-1.5 text-border">|</span>
          {formatDate(run.committerDate)}
          <span className="mx-1.5 text-border">|</span>
          {run.pushed ? 'pushed' : 'local'}
        </p>
        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
          {run.branch}
        </p>
      </div>
    </li>
  );
}

export function ActivityPage() {
  const [state, load] = useRuns();

  const runs = state.status === 'ready' ? state.runs : [];

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <PageHeader title="Activity" description="e - event stream" />
      {state.status === 'loading' && (
        <div className="space-y-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      )}
      {state.status === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Could not load activity: {state.message}
          </p>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      )}
      {state.status === 'ready' && runs.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center">
          <div className="flex size-12 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Activity className="size-6" />
          </div>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            No activity yet. Completed runs will appear here as they land.
          </p>
        </div>
      )}
      {state.status === 'ready' && runs.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border">
          <ul className="divide-y divide-border">
            {runs.map(run => (
              <EventRow key={run.branch} run={run} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
