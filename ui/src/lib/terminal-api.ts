/** One selectable agent as served by the BFF `/api/agents`. */
export interface AgentSummary {
  name: string;
  harness: string;
  model: string | null;
  /** True for agents on the store's default harness; the BFF sorts them first. */
  default: boolean;
}

/** Lifecycle of a browser-started run (ADR-0014); mirrors the BFF type. */
export type TerminalPhase = 'starting' | 'attached' | 'exited';

export interface TerminalSessionInfo {
  id: string;
  agent: string;
  slug: string;
  phase: TerminalPhase;
  containerName?: string;
  exitCode?: number;
  createdAt: string;
}

export type TerminalControlMessage =
  | { type: 'status'; session: TerminalSessionInfo }
  | { type: 'error'; message: string };

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `BFF returned HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body: keep the status line.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export async function fetchTerminalAvailable(): Promise<boolean> {
  const info = await readJson<{ terminal?: boolean }>(await fetch('/api/info'));
  return info.terminal === true;
}

export async function fetchAgents(): Promise<AgentSummary[]> {
  const body = await readJson<{ agents: AgentSummary[] }>(
    await fetch('/api/agents')
  );
  return body.agents;
}

export async function fetchSessions(): Promise<TerminalSessionInfo[]> {
  const body = await readJson<{ sessions: TerminalSessionInfo[] }>(
    await fetch('/api/terminal/sessions')
  );
  return body.sessions;
}

export async function createSession(
  agent: string,
  name?: string
): Promise<TerminalSessionInfo> {
  const body = await readJson<{ session: TerminalSessionInfo }>(
    await fetch('/api/terminal/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(name ? { agent, name } : { agent }),
    })
  );
  return body.session;
}

export async function removeSession(id: string): Promise<void> {
  const response = await fetch(
    `/api/terminal/sessions/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  );
  if (!response.ok) await readJson(response);
}

/** The BFF WebSocket carrying one session's terminal (same origin, so the BFF's Origin check passes). */
export function terminalSocketUrl(id: string): string {
  const { protocol, host } = globalThis.location;
  const scheme = protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${host}/api/terminal/ws?session=${encodeURIComponent(id)}`;
}
