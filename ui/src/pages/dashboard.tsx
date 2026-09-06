import { GitBranch, GitCommit, Boxes } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useRuns, formatDate } from '@/lib/bff';
import type { Run } from '@/lib/bff';

function RunCard({ run }: { run: Run }) {
  return (
    <li className="flex items-center justify-between gap-4 p-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {run.subject || run.slug}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {run.agent}/{run.slug}-{run.counter}
          <span className="mx-1.5 text-border">|</span>
          {formatDate(run.committerDate)}
        </p>
      </div>
      <span
        className={cn(
          'shrink-0 rounded-full border px-2 py-0.5 text-xs',
          run.pushed
            ? 'border-border text-foreground'
            : 'border-dashed border-border text-muted-foreground'
        )}
      >
        {run.pushed ? 'pushed' : 'local'}
      </span>
    </li>
  );
}

export function DashboardPage() {
  const [state, load] = useRuns();

  const runs = state.status === 'ready' ? state.runs : [];
  const agentNames = new Set(runs.map(run => run.agent));
  const stats = [
    { label: 'Runs', value: runs.length },
    { label: 'Agents', value: agentNames.size },
    { label: 'Local', value: runs.filter(run => run.local).length },
    { label: 'Pushed', value: runs.filter(run => run.pushed).length },
  ];

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <PageHeader title="Dashboard" description="e - overview" />

      {state.status === 'loading' && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      )}

      {state.status === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Could not load dashboard: {state.message}
          </p>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      )}

      {state.status === 'ready' && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {stats.map(stat => (
              <div
                key={stat.label}
                className="flex h-28 flex-col justify-between rounded-xl border border-border bg-muted/30 p-4"
              >
                <p className="text-sm text-muted-foreground">{stat.label}</p>
                <p className="text-3xl font-semibold tracking-tight">
                  {stat.value}
                </p>
              </div>
            ))}
          </div>

          <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="flex min-h-64 flex-col gap-4 rounded-xl border border-border bg-muted/30 p-4 lg:col-span-2">
              <div className="flex items-center gap-2">
                <GitBranch className="size-4 text-muted-foreground" />
                <h2 className="text-sm font-medium">Recent runs</h2>
              </div>
              {runs.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
                  <GitCommit className="size-6 text-muted-foreground" />
                  <p className="max-w-sm text-sm text-muted-foreground">
                    No runs yet. Start one with <code>e spawn</code> and it will
                    show up here.
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-border rounded-xl border border-border bg-background">
                  {runs.slice(0, 6).map(run => (
                    <RunCard key={run.branch} run={run} />
                  ))}
                </ul>
              )}
            </div>

            <div className="flex min-h-64 flex-col gap-4 rounded-xl border border-border bg-muted/30 p-4">
              <div className="flex items-center gap-2">
                <Boxes className="size-4 text-muted-foreground" />
                <h2 className="text-sm font-medium">Agents</h2>
              </div>
              <div className="flex-1 space-y-3">
                {agentNames.size === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No agents yet.
                  </p>
                ) : (
                  [...agentNames].map(name => (
                    <div
                      key={name}
                      className="flex h-16 items-center justify-between rounded-xl border border-border bg-background p-4"
                    >
                      <span className="text-sm font-medium">{name}</span>
                      <span className="text-xs text-muted-foreground">
                        {runs.filter(run => run.agent === name).length} run
                        {runs.filter(run => run.agent === name).length === 1
                          ? ''
                          : 's'}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
