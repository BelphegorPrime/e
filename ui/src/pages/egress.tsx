import { useState, type FormEvent } from 'react';
import { PageHeader } from '@/components/page-header';
import {
  useSquashedEgressLogs,
  useBlacklist,
  addBlacklistDomain,
  removeBlacklistDomain,
  type EgressLoadState,
} from '@/lib/egress-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/** One full-width table row for loading / error / empty states. */
function StatusRow({
  colSpan,
  state,
  empty,
  onRetry,
}: {
  colSpan: number;
  state: EgressLoadState<unknown>;
  empty: string;
  onRetry: () => void;
}) {
  if (state.status === 'loading') {
    return (
      <TableRow>
        <TableCell colSpan={colSpan}>Loading...</TableCell>
      </TableRow>
    );
  }
  if (state.status === 'error') {
    return (
      <TableRow>
        <TableCell colSpan={colSpan} className="text-destructive">
          Egress API unavailable: {state.message}{' '}
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </TableCell>
      </TableRow>
    );
  }
  return (
    <TableRow>
      <TableCell colSpan={colSpan}>{empty}</TableCell>
    </TableRow>
  );
}

export function EgressPage() {
  const [logsState, reloadLogs] = useSquashedEgressLogs();
  const [blacklistState, reloadBlacklist] = useBlacklist();
  const [domain, setDomain] = useState('');
  const [mutationError, setMutationError] = useState<string | undefined>();
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(
    new Set()
  );

  const blocked = new Set(
    blacklistState.status === 'ready' ? blacklistState.data.domains : []
  );
  const logs = logsState.status === 'ready' ? logsState.data : [];

  const toggleDomain = (d: string) => {
    setExpandedDomains(prev => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  };

  /** Runs a blacklist mutation, surfaces its error, and refreshes both views. */
  const mutate = async (action: () => Promise<void>) => {
    setMutationError(undefined);
    try {
      await action();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : String(error));
    }
    reloadBlacklist();
    reloadLogs();
  };

  const handleAdd = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = domain.trim();
    if (!trimmed) return;
    await mutate(() => addBlacklistDomain(trimmed));
    setDomain('');
  };

  const handleBlock = (d: string) => mutate(() => addBlacklistDomain(d));
  const handleUnblock = (d: string) => mutate(() => removeBlacklistDomain(d));

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <PageHeader title="Egress" description="Network monitoring & blocklist" />

      <form className="flex gap-2" onSubmit={handleAdd}>
        <Input
          placeholder="Enter domain to block..."
          aria-label="Domain to block"
          value={domain}
          onChange={e => setDomain(e.target.value)}
        />
        <Button type="submit">Block</Button>
      </form>
      {mutationError && (
        <p role="alert" className="text-sm text-destructive">
          {mutationError}
        </p>
      )}

      <Tabs defaultValue="logs" className="w-full">
        <TabsList>
          <TabsTrigger value="logs">Activity Logs</TabsTrigger>
          <TabsTrigger value="blacklist">Blocklist</TabsTrigger>
        </TabsList>

        <TabsContent value="logs">
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>Requests</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logsState.status !== 'ready' || logs.length === 0 ? (
                  <StatusRow
                    colSpan={4}
                    state={logsState}
                    empty="No DNS traffic recorded yet"
                    onRetry={reloadLogs}
                  />
                ) : (
                  logs.map(log => {
                    const expanded = expandedDomains.has(log.domain);
                    return (
                      <TableRow key={log.domain}>
                        <TableCell className="font-mono">
                          <button
                            type="button"
                            aria-expanded={expanded}
                            className={
                              expanded
                                ? 'break-all text-left'
                                : 'max-w-[320px] overflow-hidden text-ellipsis whitespace-nowrap text-left'
                            }
                            title={log.domain}
                            onClick={() => toggleDomain(log.domain)}
                          >
                            {log.domain}
                          </button>
                        </TableCell>
                        <TableCell>{log.count}</TableCell>
                        <TableCell>
                          {blocked.has(log.domain) ? (
                            <span className="text-destructive font-bold">
                              Blocked
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              Allowed
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          {blocked.has(log.domain) ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleUnblock(log.domain)}
                            >
                              Unblock
                            </Button>
                          ) : (
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => handleBlock(log.domain)}
                            >
                              Block
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="blacklist">
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Blocked Domain</TableHead>
                  <TableHead className="w-[100px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {blacklistState.status !== 'ready' ||
                blacklistState.data.domains.length === 0 ? (
                  <StatusRow
                    colSpan={2}
                    state={blacklistState}
                    empty="No domains blocked"
                    onRetry={reloadBlacklist}
                  />
                ) : (
                  blacklistState.data.domains.map(d => (
                    <TableRow key={d}>
                      <TableCell className="font-mono">{d}</TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleUnblock(d)}
                        >
                          Unblock
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
