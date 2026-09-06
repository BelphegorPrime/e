import { Bot } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useRuns, formatDate } from '@/lib/bff';
import type { Run } from '@/lib/bff';

interface AgentEntry {
  name: string;
  runs: Run[];
  latest: Run | undefined;
}

function groupByAgent(runs: Run[]): AgentEntry[] {
  const byName = new Map<string, Run[]>();
  for (const run of runs) {
    const list = byName.get(run.agent) ?? [];
    list.push(run);
    byName.set(run.agent, list);
  }
  return [...byName.entries()]
    .map(([name, list]) => ({
      name,
      runs: list,
      // index already sorts newest first; take the tip as the latest run.
      latest: list[0],
    }))
    .sort((a, b) => b.runs.length - a.runs.length);
}

export function AgentsPage() {
  const [state, load] = useRuns();

  const agents = state.status === 'ready' ? groupByAgent(state.runs) : [];

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <PageHeader title="Agents" description="e - agent inventory" />
      {state.status === 'loading' && (
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      )}
      {state.status === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Could not load agents: {state.message}
          </p>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      )}
      {state.status === 'ready' && agents.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center">
          <div className="flex size-12 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Bot className="size-6" />
          </div>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            No agents yet. Start a run with <code>e spawn</code> and the agent
            that executed it will appear here.
          </p>
        </div>
      )}
      {state.status === 'ready' && agents.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border">
          <ul className="divide-y divide-border">
            {agents.map(agent => (
              <li
                key={agent.name}
                className="flex items-center justify-between gap-4 bg-background p-4"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Bot className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{agent.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {agent.runs.length} run
                      {agent.runs.length === 1 ? '' : 's'}
                      {agent.latest && (
                        <>
                          <span className="mx-1.5 text-border">|</span>
                          latest {formatDate(agent.latest.committerDate)}
                        </>
                      )}
                    </p>
                  </div>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {agent.latest?.subject || agent.latest?.slug || ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
