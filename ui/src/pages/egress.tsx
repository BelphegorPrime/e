import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import {
  useSquashedEgressLogs,
  useBlacklist,
  addBlacklistDomain,
  removeBlacklistDomain,
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

export function EgressPage() {
  const logsState = useSquashedEgressLogs();
  const blacklistState = useBlacklist();
  const [domain, setDomain] = useState('');

  const handleAdd = async () => {
    if (!domain) return;
    await addBlacklistDomain(domain);
    setDomain('');
    blacklistState.load();
    logsState.load();
  };

  const handleAddWithDomain = async (d: string) => {
    await addBlacklistDomain(d);
    blacklistState.load();
    logsState.load();
  };

  const handleRemove = async (d: string) => {
    await removeBlacklistDomain(d);
    blacklistState.load();
    logsState.load();
  };

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <PageHeader title="Egress" description="Network monitoring & blocklist" />

      <div className="flex gap-2">
        <Input
          placeholder="Enter domain to block..."
          value={domain}
          onChange={e => setDomain(e.target.value)}
        />
        <Button onClick={handleAdd}>Block</Button>
      </div>

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
                  <TableHead>Last Seen</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logsState.loading ? (
                  <TableRow>
                    <TableCell colSpan={5}>Loading...</TableCell>
                  </TableRow>
                ) : (
                  logsState.logs.map(log => (
                    <TableRow key={log.domain}>
                      <TableCell className="font-mono">{log.domain}</TableCell>
                      <TableCell>{log.count}</TableCell>
                      <TableCell>
                        {blacklistState.domains.includes(log.domain) ? (
                          <span className="text-destructive font-bold">
                            Blocked
                          </span>
                        ) : (
                          <span className="text-success">Allowed</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {blacklistState.domains.includes(log.domain) ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRemove(log.domain)}
                          >
                            Unblock
                          </Button>
                        ) : (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleAddWithDomain(log.domain)}
                          >
                            Block
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
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
                {blacklistState.loading ? (
                  <TableRow>
                    <TableCell colSpan={2}>Loading...</TableCell>
                  </TableRow>
                ) : blacklistState.domains.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={2}>No domains blocked</TableCell>
                  </TableRow>
                ) : (
                  blacklistState.domains.map(d => (
                    <TableRow key={d}>
                      <TableCell className="font-mono">{d}</TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRemove(d)}
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
