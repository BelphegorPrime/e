import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Loader2, Plug, Play, TerminalSquare, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  createSession,
  fetchAgents,
  fetchSessions,
  fetchTerminalAvailable,
  fetchTerminalOptions,
  removeSession,
  terminalSocketUrl,
  type AgentSummary,
  type McpOption,
  type TerminalControlMessage,
  type TerminalOptions,
  type TerminalSessionInfo,
} from '@/lib/terminal-api';
import { cn } from '@/lib/utils';

const SESSIONS_REFRESH_MS = 4000;

// The terminal palette follows the app palette (index.css): the dark surface
// tokens for dark mode, plain white for light mode.
const DARK_THEME = {
  background: '#0b0e14',
  foreground: '#e6e6ef',
  cursor: '#e6e6ef',
  selectionBackground: '#e54d5e55',
};
const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1a1a2e',
  cursor: '#1a1a2e',
  selectionBackground: '#e54d5e33',
};

function isDarkMode(): boolean {
  return globalThis.document.documentElement.classList.contains('dark');
}

/** Follows the `.dark` class the theme hook toggles on the document root. */
function useDarkMode(): boolean {
  const [dark, setDark] = useState(isDarkMode);
  useEffect(() => {
    const root = globalThis.document.documentElement;
    const observer = new MutationObserver(() => setDark(isDarkMode()));
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

function phaseLabel(session: TerminalSessionInfo): string {
  switch (session.phase) {
    case 'starting':
      return 'starting';
    case 'attached':
      return 'live';
    case 'exited':
      return session.exitCode === 0 ? 'done' : `exit ${session.exitCode}`;
  }
}

function phaseClass(session: TerminalSessionInfo): string {
  switch (session.phase) {
    case 'starting':
      return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
    case 'attached':
      return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400';
    case 'exited':
      return session.exitCode === 0
        ? 'bg-muted text-muted-foreground'
        : 'bg-destructive/15 text-destructive';
  }
}

interface TerminalViewProps {
  session: TerminalSessionInfo;
  onStatus: (session: TerminalSessionInfo) => void;
}

/**
 * One xterm.js instance bound to one session's WebSocket. Binary frames are
 * terminal bytes in both directions; text frames are JSON control messages
 * (resize up, status/error down). Remounts per session id.
 */
function TerminalView({ session, onStatus }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const dark = useDarkMode();
  const [connection, setConnection] = useState<
    'connecting' | 'open' | 'closed'
  >('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: isDarkMode() ? DARK_THEME : LIGHT_THEME,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;

    const socket = new WebSocket(terminalSocketUrl(session.id));
    socket.binaryType = 'arraybuffer';
    const encoder = new TextEncoder();

    const sendResize = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({
          type: 'resize',
          cols: terminal.cols,
          rows: terminal.rows,
        })
      );
    };
    const refit = () => {
      try {
        fit.fit();
      } catch {
        // The host may be hidden mid-layout; the next observation fits again.
      }
      sendResize();
    };

    socket.addEventListener('open', () => {
      setConnection('open');
      refit();
      terminal.focus();
    });
    socket.addEventListener('message', event => {
      if (event.data instanceof ArrayBuffer) {
        terminal.write(new Uint8Array(event.data));
        return;
      }
      try {
        const message = JSON.parse(
          String(event.data)
        ) as TerminalControlMessage;
        if (message.type === 'status') onStatus(message.session);
        if (message.type === 'error') setError(message.message);
      } catch {
        // Ignore malformed control frames.
      }
    });
    socket.addEventListener('close', () => setConnection('closed'));
    socket.addEventListener('error', () => setConnection('closed'));

    const inputDisposable = terminal.onData(data => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encoder.encode(data));
      }
    });
    const resizeDisposable = terminal.onResize(sendResize);
    const observer = new ResizeObserver(() => refit());
    observer.observe(host);
    refit();

    return () => {
      observer.disconnect();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      socket.close();
      terminal.dispose();
      terminalRef.current = null;
    };
    // Rebinding on every status callback would tear the terminal down; the
    // session id is the identity that matters.
  }, [session.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.theme = dark ? DARK_THEME : LIGHT_THEME;
  }, [dark]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-medium">{session.agent}</span>
          <span className="text-muted-foreground">/</span>
          <span className="truncate font-mono text-muted-foreground">
            e/{session.agent}/{session.slug}
          </span>
          {session.containerName && (
            <span className="hidden truncate font-mono text-muted-foreground md:inline">
              · {session.containerName}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={cn(
              'rounded-full px-2 py-0.5 font-medium',
              phaseClass(session)
            )}
          >
            {phaseLabel(session)}
          </span>
          {connection !== 'open' && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Plug className="size-3" />
              {connection === 'connecting' ? 'connecting' : 'disconnected'}
            </span>
          )}
        </div>
      </div>
      {error && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      <div
        ref={hostRef}
        className={cn('min-h-0 flex-1 p-2', dark ? 'bg-[#0b0e14]' : 'bg-white')}
      />
    </div>
  );
}

/** Tiny transport badge: container MCP servers run as sidecar containers. */
function McpBadge({ entry }: { entry: McpOption }) {
  const badge = entry.transport === 'container' ? 'sidecar' : 'remote'
  return (
    <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
      {badge}
    </span>
  );
}

export function TerminalPage() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agent, setAgent] = useState('');
  const [name, setName] = useState('');
  const [options, setOptions] = useState<TerminalOptions | null>(null);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedMcp, setSelectedMcp] = useState<string[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await fetchSessions());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [terminalAvailable, list, runOptions] = await Promise.all([
          fetchTerminalAvailable(),
          fetchAgents(),
          fetchTerminalOptions(),
        ]);
        setAvailable(terminalAvailable);
        setAgents(list);
        setOptions(runOptions);
        if (list.length > 0) setAgent(current => current || list[0].name);
      } catch (cause) {
        setAvailable(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      await refreshSessions();
    })();
  }, [refreshSessions]);

  // Sessions of other tabs (or ones started from the CLI's serve) show up
  // through the periodic refresh; the selected one also updates over its socket.
  useEffect(() => {
    const timer = globalThis.setInterval(
      () => void refreshSessions(),
      SESSIONS_REFRESH_MS
    );
    return () => globalThis.clearInterval(timer);
  }, [refreshSessions]);

  const updateSession = useCallback((updated: TerminalSessionInfo) => {
    setSessions(current =>
      current.some(entry => entry.id === updated.id)
        ? current.map(entry => (entry.id === updated.id ? updated : entry))
        : [updated, ...current]
    );
  }, []);

  const toggleName = (
    current: string[],
    set: (next: string[]) => void,
    name: string
  ): void => {
    set(
      current.includes(name)
        ? current.filter(entry => entry !== name)
        : [...current, name]
    );
  };

  const start = async () => {
    if (!agent) return;
    setStarting(true);
    setError(null);
    try {
      const session = await createSession(agent, name.trim() || undefined, {
        skills: selectedSkills,
        mcp: selectedMcp,
      });
      setName('');
      updateSession(session);
      setSelectedId(session.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await removeSession(id);
      setSessions(current => current.filter(entry => entry.id !== id));
      if (selectedId === id) setSelectedId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const selected = sessions.find(entry => entry.id === selectedId) ?? null;

  return (
    <div className="flex h-screen flex-col gap-6 p-6">
      <PageHeader
        title="Terminal"
        description="e - start an agent and work in its harness from here"
      />
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {available === false && !error && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-300">
          No container engine socket was found by <code>e serve</code>, so runs
          cannot be started from the browser. Start <code>e serve</code> where
          the Docker socket (or the Podman service socket) is available.
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <aside className="flex w-full shrink-0 flex-col gap-4 lg:w-72">
          <form
            className="flex flex-col gap-3 rounded-xl border border-border bg-background p-4"
            onSubmit={event => {
              event.preventDefault();
              void start();
            }}
          >
            <h2 className="text-sm font-semibold">New run</h2>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Agent
              <select
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                value={agent}
                onChange={event => setAgent(event.target.value)}
                disabled={agents.length === 0}
              >
                {agents.length === 0 && (
                  <option value="">No agents found</option>
                )}
                {agents.map(entry => (
                  <option key={entry.name} value={entry.name}>
                    {entry.name} ({entry.harness}
                    {entry.model ? ` · ${entry.model}` : ''})
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Run name (optional)
              <Input
                value={name}
                onChange={event => setName(event.target.value)}
                placeholder="fix-login-redirect"
                pattern="[a-z0-9][a-z0-9-]*"
                title="lowercase letters, digits and hyphens"
              />
            </label>
            <div className="rounded-md border border-border">
              <button
                type="button"
                className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-foreground"
                onClick={() => setAdvancedOpen(open => !open)}
                aria-expanded={advancedOpen}
              >
                Advanced
                <span className="text-muted-foreground">
                  {advancedOpen ? '−' : '+'}
                </span>
              </button>
              {advancedOpen && (
                <div className="flex flex-col gap-3 border-t border-border px-3 py-2">
                  <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                    Skills
                    {options === null ? (
                      <span className="text-xs">Loading…</span>
                    ) : options.skills.length === 0 ? (
                      <span className="text-xs">
                        No skill under <code>.e/skills</code>.
                      </span>
                    ) : (
                      <span className="flex flex-col gap-1">
                        {options.skills.map(skill => (
                          <label
                            key={skill}
                            className="flex cursor-pointer items-center gap-2 text-foreground"
                          >
                            <input
                              type="checkbox"
                              className="size-3.5 accent-[hsl(var(--primary))]"
                              checked={selectedSkills.includes(skill)}
                              onChange={() =>
                                toggleName(
                                  selectedSkills,
                                  setSelectedSkills,
                                  skill
                                )
                              }
                            />
                            <span className="font-mono">{skill}</span>
                          </label>
                        ))}
                      </span>
                    )}
                  </label>
                  <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                    MCP servers (container ones run as sidecars)
                    {options === null ? (
                      <span className="text-xs">Loading…</span>
                    ) : options.mcp.length === 0 ? (
                      <span className="text-xs">
                        No MCP server under <code>.e/mcp</code>.
                      </span>
                    ) : (
                      <span className="flex flex-col gap-1">
                        {options.mcp.map(entry => (
                          <label
                            key={entry.name}
                            className="flex cursor-pointer items-center gap-2 text-foreground"
                          >
                            <input
                              type="checkbox"
                              className="size-3.5 accent-[hsl(var(--primary))]"
                              checked={selectedMcp.includes(entry.name)}
                              onChange={() =>
                                toggleName(
                                  selectedMcp,
                                  setSelectedMcp,
                                  entry.name
                                )
                              }
                            />
                            <span className="truncate font-mono">
                              {entry.name}
                            </span>
                            <McpBadge entry={entry} />
                          </label>
                        ))}
                      </span>
                    )}
                  </label>
                </div>
              )}
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={!agent || starting || available === false}
            >
              {starting ? <Loader2 className="animate-spin" /> : <Play />}
              Start
            </Button>
            <p className="text-xs text-muted-foreground">
              Runs <code>e spawn {agent || '<agent>'}</code> in the directory{' '}
              <code>e serve</code> was started in, plus any selected skills and
              MCP servers. Exit the harness to let e commit and push the run.
            </p>
          </form>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
            <h2 className="border-b border-border px-4 py-2 text-sm font-semibold">
              Sessions
            </h2>
            {sessions.length === 0 ? (
              <p className="p-4 text-xs text-muted-foreground">
                No sessions yet. Sessions live as long as this{' '}
                <code>e serve</code> process.
              </p>
            ) : (
              <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
                {sessions.map(entry => (
                  <li key={entry.id}>
                    <div
                      className={cn(
                        'flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/50',
                        entry.id === selectedId && 'bg-primary/10'
                      )}
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 flex-col items-start text-left"
                        onClick={() => setSelectedId(entry.id)}
                      >
                        <span className="truncate font-medium">
                          {entry.agent}
                        </span>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {entry.slug}
                        </span>
                      </button>
                      <span
                        className={cn(
                          'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
                          phaseClass(entry)
                        )}
                      >
                        {phaseLabel(entry)}
                      </span>
                      {entry.phase === 'exited' && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7 shrink-0"
                          aria-label="Remove session"
                          onClick={() => void remove(entry.id)}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
        <section className="flex min-h-[360px] min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
          {selected ? (
            <TerminalView
              key={selected.id}
              session={selected}
              onStatus={updateSession}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
              <div className="flex size-12 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <TerminalSquare className="size-6" />
              </div>
              <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                Start a run or pick a session to see its harness here. The
                harness runs in its container; this view is its TTY.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
