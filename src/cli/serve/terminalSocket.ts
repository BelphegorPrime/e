import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { TerminalSessions } from './terminalSessions.js';

/** The BFF path the browser terminal upgrades on; `?session=<id>` names the run. */
export const TERMINAL_WS_PATH = '/api/terminal/ws';

/**
 * Browsers do not apply the same-origin policy to WebSockets, so any page a
 * user has open could otherwise type into a run. A browser always sends
 * `Origin`; it must name this very server. No `Origin` means a non-browser
 * client (curl, a test), which the loopback bind already scopes.
 */
export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined
): boolean {
  if (origin === undefined) return true;
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

function parseControl(raw: string): ResizeMessage | undefined {
  try {
    const message = JSON.parse(raw) as Partial<ResizeMessage>;
    if (
      message.type === 'resize' &&
      typeof message.cols === 'number' &&
      typeof message.rows === 'number'
    ) {
      return { type: 'resize', cols: message.cols, rows: message.rows };
    }
  } catch {
    // Malformed control frames are dropped, not fatal.
  }
  return undefined;
}

function bindSocket(
  socket: WebSocket,
  sessionId: string,
  sessions: TerminalSessions
): void {
  const detach = sessions.attachClient(sessionId, {
    write: data => {
      if (socket.readyState === socket.OPEN) socket.send(data);
    },
    control: message => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    },
  });
  if (!detach) {
    socket.close(4004, 'Unknown terminal session');
    return;
  }
  // Binary frames are keystrokes for the harness; text frames are control.
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      sessions.input(
        sessionId,
        Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      );
      return;
    }
    const control = parseControl(data.toString());
    if (control) sessions.resize(sessionId, control.cols, control.rows);
  });
  socket.once('close', detach);
}

/**
 * Mounts the terminal WebSocket on the BFF's HTTP server (ADR-0014). Only
 * {@link TERMINAL_WS_PATH} upgrades; every other upgrade is refused, since
 * nothing else on the BFF port speaks WebSocket (the OmniRoute embed proxy
 * has its own listener).
 */
export function attachTerminalWebSocket(
  server: Server,
  sessions: TerminalSessions
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== TERMINAL_WS_PATH) {
      socket.destroy();
      return;
    }
    if (!isOriginAllowed(request.headers.origin, request.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const sessionId = url.searchParams.get('session') ?? '';
    wss.handleUpgrade(request, socket, head, ws =>
      bindSocket(ws, sessionId, sessions)
    );
  });
  server.once('close', () => wss.close());
  return wss;
}
