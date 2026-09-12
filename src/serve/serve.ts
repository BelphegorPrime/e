import express, { type Express } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Command } from 'commander';
import { resolveUiDirectory } from './assets.js';
import type { Git } from '../git/index.js';
import { HostGit } from '../git/host.js';
import {
  buildRunIndex,
  parseRunBranch,
  resolveRunRef,
} from '../runs/runIndex.js';
import { eBaseDir } from '../store/paths.js';
import { log } from '../utils/log.js';
import { env } from '../utils/env.js';
import { resolveFreePortBlock } from '../utils/port.js';
import { E_VERSION } from '../version.js';
import { type ModelsResponse } from '../modelStatus.js';
import {
  isRemoteAgent,
  listAgents as listStoreAgents,
} from '../agent/index.js';
import { findRoot } from '../store/root.js';
import {
  resolveEngineSocketPath,
  UnixSocketEngineApi,
} from './containerApi.js';
import { TerminalRequestError, TerminalSessions } from './terminalSessions.js';
import { attachTerminalWebSocket } from './terminalSocket.js';
import { selfInvocation } from '../utils/selfInvoke.js';
import { readConfig } from '../store/config.js';
import { HARNESSES } from '../harness/index.js';
import { defaultWorktreesDir } from '../runs/worktreesDir.js';
import { brokerSpoolDirFor } from '../runs/runBroker.js';
import { listRecords, readRunInfo } from '../broker/spool.js';
import { streamStatusEvents } from '../broker/events.js';
import {
  STATUS_EVENTS_HEARTBEAT_MS,
  STATUS_EVENTS_POLL_MS,
} from '../broker/constants.js';
import type { StatusResponse } from '../broker/types.js';
import { a2aAccess, type A2aAccess } from '../a2a/access.js';
import { renderAgentCard } from '../a2a/agentCard.js';
import { A2aTasks, a2aSpoolDirFor, removeA2aSpool } from '../a2a/tasks.js';
import {
  a2aRpcHandler,
  agentCardHandler,
  type A2aServerDeps,
} from '../a2a/server.js';
import { AGENT_CARD_PATH } from '../a2a/wire.js';

/** The JSON-RPC endpoint of the A2A facade (ADR-0015), outside `/api` so the card can name it plainly. */
export const A2A_RPC_PATH = '/a2a';

const serveStatePath = path.join(eBaseDir(), 'serve.json');

export interface ServeState {
  pid: number;
  host: string;
  port: number;
}

export interface ServeProbes {
  /** Returns whether `pid` belongs to a live process. */
  isAlive?: (pid: number) => boolean;
  /** True when `url` answers a health probe. */
  probeHealth?: (url: string) => Promise<boolean>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return undefined;
}

export interface ServeOptions {
  host?: string;
  port?: string;
  detached?: boolean;
}

/**
 * The argv for the background `serve` child: this CLI's own re-invocation
 * prefix (see {@link selfInvocation}) plus the user's `serve` arguments minus
 * the detach flag. `sea` is injectable so the single-executable shape is
 * testable under plain Node.
 */
export function detachedServeArguments(
  argv: string[],
  sea?: boolean
): string[] {
  const { prefix } = selfInvocation(argv, sea);
  return [
    ...prefix,
    ...argv
      .slice(2)
      .filter(argument => argument !== '--detached' && argument !== '-d'),
  ];
}

function startDetachedServe(): Promise<void> {
  const { command } = selfInvocation();
  const child = spawn(command, detachedServeArguments(process.argv), {
    detached: true,
    stdio: 'ignore',
    env: env.withServeDetached(),
  });
  child.unref();
  return new Promise((resolve, reject) => {
    // A spawn failure (bad execPath, EMFILE) would otherwise only surface as
    // the generic 5s "did not become ready" timeout below.
    child.once('error', error =>
      reject(
        new Error(`Could not start the detached UI server: ${error.message}`)
      )
    );
    const deadline = Date.now() + 5000;
    const checkState = (): void => {
      if (readServeState()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('Detached UI server did not become ready'));
        return;
      }
      setTimeout(checkState, 50);
    };
    checkState();
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still means the process exists (owned by another user).
    return errorCode(error) === 'EPERM';
  }
}

async function healthProbe(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * True when the recorded detached server is really up: its pid is alive and
 * its `/api/health` answers. A reboot leaves a file whose pid is dead and
 * whose port answers nothing - this is how we tell that entry apart.
 */
export async function isServeStateLive(
  state: ServeState,
  probes: ServeProbes = {}
): Promise<boolean> {
  const isAlive = probes.isAlive ?? isProcessAlive;
  const probe = probes.probeHealth ?? healthProbe;
  return (
    isAlive(state.pid) &&
    (await probe(`http://${state.host}:${state.port}/api/health`))
  );
}

/**
 * Decides whether a re-invocation should reuse the recorded server or start
 * fresh. No recorded entry (or a stale one) means a fresh start; only a
 * verified-live entry short-circuits to "already serving".
 */
export async function shouldReuseDetachedServe(
  existing: ServeState | undefined,
  probes: ServeProbes = {}
): Promise<boolean> {
  return existing !== undefined && (await isServeStateLive(existing, probes));
}

function writeServeState(state: ServeState): void {
  fs.mkdirSync(path.dirname(serveStatePath), { recursive: true });
  const temporaryPath = `${serveStatePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`);
  fs.renameSync(temporaryPath, serveStatePath);
}

function removeServeState(): void {
  try {
    fs.unlinkSync(serveStatePath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

function readServeState(): ServeState | undefined {
  try {
    const state = JSON.parse(
      fs.readFileSync(serveStatePath, 'utf8')
    ) as Partial<ServeState>;
    if (
      !Number.isInteger(state.pid) ||
      typeof state.host !== 'string' ||
      !Number.isInteger(state.port)
    ) {
      return undefined;
    }
    return state as ServeState;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    // A truncated or hand-edited file is stale state, not a crash: the caller
    // removes what it cannot read, and `e serve` / `e serve stop` keep working.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function stopDetachedServe(): void {
  const state = readServeState();
  if (!state) {
    removeServeState();
    log.info('No detached UI server is running');
    return;
  }

  try {
    process.kill(state.pid, 'SIGTERM');
    log.info(
      `Stopping detached UI server on http://${state.host}:${state.port}`
    );
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error;
    removeServeState();
    log.info('Removed stale detached UI server state');
  }
}

function trackDetachedServer(server: Server, host: string, port: number): void {
  writeServeState({ pid: process.pid, host, port });
  server.once('close', removeServeState);
  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

/** Dependency injection point for the BFF's live views (ADR-0010). */
export interface ServeAppDeps {
  /** Base URL of the local llama.cpp router, e.g. `http://127.0.0.1:9931`. */
  // TODO: Check if we need this property at all. We now have more ai runtimes.
  llamaBaseUrl?: string;
  /** Base URL of the egress container API (ADR-0012), e.g. `http://127.0.0.1:20129`. */
  egressApiUrl?: string;
  /**
   * Loopback port of the OmniRoute embed proxy (see `startOmniRouteEmbedProxy`),
   * published via `/api/info` so the UI can frame the dashboard. `null` when
   * the proxy is not running (tests, or a BFF started without it).
   */
  omniRouteEmbedPort?: number | null;
  fetchImpl?: typeof fetch;
  /**
   * Git read source for the branch-backed runs index (ADR-0010). Defaults to
   * the host git executable; tests inject a fake.
   */
  git?: Git;
  /**
   * Browser-started runs (ADR-0014). Absent in tests that do not exercise the
   * terminal; the routes then answer 503.
   */
  terminal?: TerminalSessions;
  /** The store's agents for the terminal's "start a run" picker; tests inject a fake. */
  listAgents?: () => AgentSummary[];
  /**
   * The A2A facade (ADR-0015): the tasks, the access decision and the
   * endpoint URL the agent card advertises. Absent in tests that do not
   * exercise it; the card then answers 404 and the endpoint 503.
   */
  a2a?: { tasks: A2aTasks; access: A2aAccess; url: string };
  /** Where run spools live (`<worktreesDir>/.broker/<runName>`), for the siblings view; default: the platform rule. */
  worktreesDir?: string;
}

/** The runs a `/api/runs/*` path may end in: the sibling view of a run with a broker (ADR-0015). */
const SIBLINGS_SUFFIX = '/siblings';
const SIBLINGS_EVENTS_SUFFIX = '/siblings/events';

/** One selectable agent as the UI sees it. */
export interface AgentSummary {
  name: string;
  /** The harness the agent runs on, or `a2a` for a remote A2A agent (ADR-0015). */
  harness: string;
  /** The provider's configured model id (`auto` included), or null for a default agent. */
  model: string | null;
  /** True when the agent runs on the store's `defaultHarness`; the picker lists those first. */
  default: boolean;
  /** `a2a` for a remote agent reached over the Agent2Agent protocol; absent for a harness agent. */
  transport?: 'a2a';
  /** A remote agent's own description, when it has one. */
  description?: string;
}

function storeAgents(): AgentSummary[] {
  const root = findRoot();
  const { defaultHarness } = readConfig(root);
  return listStoreAgents(root).map(agent =>
    isRemoteAgent(agent)
      ? {
          name: agent.name,
          harness: 'a2a',
          model: null,
          default: false,
          transport: 'a2a',
          ...(agent.description !== undefined
            ? { description: agent.description }
            : {}),
        }
      : {
          name: agent.name,
          harness: agent.harness,
          model: agent.provider?.model ?? null,
          default: agent.harness === defaultHarness,
        }
  );
}

export function createServeApp(
  uiDirectory: string,
  deps: ServeAppDeps = {}
): Express {
  const {
    llamaBaseUrl = env.localLlamaUrl,
    egressApiUrl = env.egressApiUrl,
    fetchImpl = fetch,
    omniRouteEmbedPort = null,
    git = new HostGit(),
    terminal,
    listAgents = storeAgents,
    a2a,
    worktreesDir = defaultWorktreesDir(),
  } = deps;

  const app = express();
  app.use('/api', express.json());

  // e as an A2A agent (ADR-0015): the card at its well-known path, one
  // JSON-RPC endpoint. Both are delegations - a task is `e spawn` in a
  // headless child - so the BFF still holds no orchestration of its own.
  const a2aDeps: A2aServerDeps = a2a
    ? {
        tasks: a2a.tasks,
        access: a2a.access,
        card: () =>
          renderAgentCard({
            url: a2a.url,
            version: E_VERSION,
            agents: listAgents().filter(agent => agent.transport !== 'a2a'),
            bearer: a2a.access.enabled && a2a.access.requireBearer,
          }),
      }
    : {
        tasks: undefined as unknown as A2aTasks,
        access: {
          enabled: false,
          reason: 'The A2A endpoint is not configured.',
        },
        card: () => {
          throw new Error('unreachable');
        },
      };
  app.get(AGENT_CARD_PATH, agentCardHandler(a2aDeps));
  app.post(
    A2A_RPC_PATH,
    express.text({ type: () => true, limit: '1mb' }),
    a2aRpcHandler(a2aDeps)
  );

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.get('/api/info', (_request, response) => {
    response.json({
      name: 'e',
      version: E_VERSION,
      omniRouteEmbedPort,
      // The terminal needs both a session manager and an engine socket.
      terminal: terminal?.engineAvailable ?? false,
    });
  });

  app.get('/api/agents', (_request, response) => {
    try {
      const agents = [...listAgents()].sort((a, b) => {
        if (a.default && !b.default) return -1;
        if (!a.default && b.default) return 1;
        return 0;
      });

      response.json({ agents });
    } catch (error) {
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  // Browser-started runs (ADR-0014): the one write path besides egress
  // blacklisting. Starting a run is exactly `e spawn <agent> --name <slug>`
  // in a headless child; the routes never touch git or containers themselves.
  const requireTerminal = (
    response: express.Response
  ): TerminalSessions | undefined => {
    if (!terminal) {
      response
        .status(503)
        .json({ error: 'Terminal sessions are not available' });
    }
    return terminal;
  };

  app.get('/api/terminal/sessions', (_request, response) => {
    const sessions = requireTerminal(response);
    if (sessions) response.json({ sessions: sessions.list() });
  });

  app.post('/api/terminal/sessions', (request, response) => {
    const sessions = requireTerminal(response);
    if (!sessions) return;
    const body = (request.body ?? {}) as { agent?: unknown; name?: unknown };
    try {
      const session = sessions.start({
        agent: typeof body.agent === 'string' ? body.agent : '',
        name: typeof body.name === 'string' ? body.name : undefined,
      });
      response.status(201).json({ session });
    } catch (error) {
      if (error instanceof TerminalRequestError) {
        response.status(400).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/terminal/sessions/:id', (request, response) => {
    const sessions = requireTerminal(response);
    if (!sessions) return;
    const session = sessions.get(request.params.id);
    if (!session) {
      response.status(404).json({ error: 'Not found' });
      return;
    }
    response.json({ session });
  });

  app.delete('/api/terminal/sessions/:id', (request, response) => {
    const sessions = requireTerminal(response);
    if (!sessions) return;
    try {
      sessions.remove(request.params.id);
      response.status(204).end();
    } catch (error) {
      if (error instanceof TerminalRequestError) {
        response.status(409).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  // Observer-first model view (ADR-0010): a raw snapshot of llama.cpp's
  // `/models` payload, so the UI can render download/load progress without
  // reaching the stack itself.
  app.get('/api/omniroute/models', async (_request, response) => {
    try {
      const res = await fetchImpl(`${llamaBaseUrl}/models`);
      if (!res.ok) {
        response
          .status(502)
          .json({ error: `llama.cpp returned HTTP ${res.status}` });
        return;
      }
      const body = (await res.json()) as ModelsResponse;
      response.json(body);
    } catch {
      response.status(503).json({ error: 'llama.cpp stack is not running' });
    }
  });

  // Branch-backed runs index (ADR-0010): runs _are_ git branches
  // (`e/<agent>/<slug>-N` per ADR-0003), so everything here reads git. No
  // write endpoints and no live timing or streaming logs yet - the namespace
  // stays extensible by layering a state store on top.
  app.get('/api/runs', (_request, response) => {
    try {
      response.json({ runs: buildRunIndex(git.listRunRefs('e')) });
    } catch (error) {
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  // Covers `/api/runs/e/<agent>/<slug>-N` (per-run status) and
  // `/api/runs/e/<agent>/<slug>-N/logs`. The handler extracts the branch from
  // request.path because Express 4 route params cannot capture slashes.
  const handleRunRequest = (
    request: express.Request,
    response: express.Response
  ): void => {
    const restPath = request.path.replace(/^\/api\/runs\//, '');
    if (!restPath) {
      response.status(404).json({ error: 'Not found' });
      return;
    }
    const logsRequested = restPath.endsWith('/logs');
    const siblingsRequested = restPath.endsWith(SIBLINGS_SUFFIX);
    const siblingEventsRequested = restPath.endsWith(SIBLINGS_EVENTS_SUFFIX);
    const branchName = logsRequested
      ? restPath.slice(0, -'/logs'.length)
      : siblingEventsRequested
        ? restPath.slice(0, -SIBLINGS_EVENTS_SUFFIX.length)
        : siblingsRequested
          ? restPath.slice(0, -SIBLINGS_SUFFIX.length)
          : restPath;
    const identity = parseRunBranch(branchName);
    if (!identity) {
      response.status(404).json({ error: 'Not found' });
      return;
    }
    // The siblings of a live run with a broker (ADR-0013/0015): read from its
    // spool on the host, the same records the broker serves, as a snapshot or
    // as Server-Sent Events. A run without a spool has no siblings.
    if (siblingsRequested || siblingEventsRequested) {
      const spool = brokerSpoolDirFor(
        worktreesDir,
        branchName.replace(/\//g, '-')
      );
      const snapshot = (): StatusResponse => ({
        run: readRunInfo(spool),
        siblings: listRecords(spool),
      });
      if (siblingEventsRequested) {
        streamStatusEvents(request, response, {
          snapshot,
          pollMs: STATUS_EVENTS_POLL_MS,
          heartbeatMs: STATUS_EVENTS_HEARTBEAT_MS,
        });
        return;
      }
      response.json(snapshot());
      return;
    }
    try {
      // One enumeration per request keeps status and logs consistent with the
      // index and answers the `pushed`/existence checks without extra calls.
      const refs = git.listRunRefs('e');
      const entry = buildRunIndex(refs).find(run => run.branch === branchName);
      if (!entry) {
        response.status(404).json({ error: 'Not found' });
        return;
      }
      if (logsRequested) {
        const ref = resolveRunRef(refs, branchName);
        response.json({
          branch: entry.branch,
          commits: ref ? git.runLog(ref.name) : [],
        });
        return;
      }
      const ref = resolveRunRef(refs, branchName);
      const commits = ref ? git.runLog(ref.name) : [];
      response.json({
        branch: entry.branch,
        agent: entry.agent,
        slug: entry.slug,
        counter: entry.counter,
        commits: commits.length,
        latest: commits[0] ?? null,
        local: entry.local,
        pushed: entry.pushed,
      });
    } catch (error) {
      response.status(500).json({ error: errorMessage(error) });
    }
  };

  // Match both status and logs endpoints
  app.get('/api/runs/*', handleRunRequest);

  // Egress query + mutation API proxy (ADR-0012). The BFF forwards the path,
  // query string and JSON body to the egress container's own HTTP listener;
  // it adds no write logic of its own.
  const EGRESS_PROXY_TIMEOUT_MS = 5000;

  const handleEgressRequest: express.RequestHandler = async (
    request,
    response
  ) => {
    // `request.path` drops the query string; the GET /logs filters
    // (since/domain/action/limit) live there, so forward originalUrl's tail.
    const restPath = request.originalUrl.replace(/^\/api\/egress\//, '');
    if (!restPath || restPath.startsWith('?')) {
      response.status(404).json({ error: 'Not found' });
      return;
    }
    if (!egressApiUrl) {
      response.status(503).json({ error: 'Egress API not configured' });
      return;
    }
    try {
      const upstreamUrl = `${egressApiUrl}/${restPath}`;
      const init: {
        method: string;
        headers: Record<string, string>;
        body?: string;
        signal: AbortSignal;
      } = {
        method: request.method,
        headers: {},
        // The egress API reads two small files per request; a hung container
        // must not pin a BFF worker forever.
        signal: AbortSignal.timeout(EGRESS_PROXY_TIMEOUT_MS),
      };
      if (request.method === 'POST' || request.method === 'DELETE') {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(request.body);
      }
      const res = await fetchImpl(upstreamUrl, init);
      const body = await res.text();
      response.status(res.status);
      const contentType = res.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        response.json(JSON.parse(body));
      } else {
        response.send(body);
      }
    } catch (error) {
      response
        .status(502)
        .json({ error: `Egress API error: ${errorMessage(error)}` });
    }
  };

  app.all('/api/egress/*', handleEgressRequest);

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'Not found' });
  });

  app.use(express.static(uiDirectory));
  app.get('*', (_request, response) => {
    response.sendFile('index.html', { root: uiDirectory });
  });

  return app;
}

export function startServeServer(
  app: Express,
  host: string,
  port: number
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

/**
 * OmniRoute embed proxy: a second loopback listener that mirrors OmniRoute
 * 1:1 so the UI can frame its dashboard.
 *
 * OmniRoute sends `frame-ancestors 'none'` + `X-Frame-Options: DENY`, which
 * blocks the iframe when it points at OmniRoute directly, and both knobs are
 * build-time in its image. It also ships without a basePath: only its pages
 * live under `/dashboard`, while the login redirect (`/login`), assets
 * (`/_next/*`) and API (`/api/*`) are root-anchored. A path-prefixed proxy on
 * the BFF port would therefore either have to rewrite HTML and JS or share
 * the BFF's `/api` namespace, so the mirror gets its own port instead: every
 * path is forwarded unchanged, only the framing headers are stripped and the
 * session cookie is rescoped. The UI frames `http://<bff-host>:<port>/dashboard`,
 * which is same-site with the BFF origin, so the dashboard's session cookie
 * still flows inside the frame.
 */
export function createOmniRouteEmbedProxy(
  omniRoutedUrl: string = env.omniRoutedUrl
): ReturnType<typeof createProxyMiddleware> {
  return createProxyMiddleware({
    target: omniRoutedUrl,
    changeOrigin: true,
    // The dashboard opens a Live WebSocket to its own origin.
    ws: true,
    on: {
      proxyRes: proxyResponse => {
        delete proxyResponse.headers['content-security-policy'];
        delete proxyResponse.headers['x-frame-options'];
        // Keep the dashboard session, but scope its cookies to this origin:
        // a `Domain` for OmniRoute's host would be rejected by the browser,
        // and `Secure` never reaches a plain-http loopback proxy.
        const cookies = proxyResponse.headers['set-cookie'];
        if (cookies) {
          proxyResponse.headers['set-cookie'] = cookies.map(cookie =>
            cookie
              .split(';')
              .map(part => part.trim())
              .filter(part => !/^(domain=|secure$)/i.test(part))
              .join('; ')
          );
        }
      },
    },
  });
}

export function startOmniRouteEmbedProxy(
  host: string,
  port: number,
  omniRoutedUrl: string = env.omniRoutedUrl
): Promise<Server> {
  const proxy = createOmniRouteEmbedProxy(omniRoutedUrl);
  const server = http.createServer(proxy);
  server.on('upgrade', proxy.upgrade);
  return new Promise((resolve, reject) => {
    server.listen(port, host);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

/** The embed proxy sits right next to the BFF port so one `--port` configures both. */
export function omniRouteEmbedPortFor(bffPort: number): number {
  return bffPort + 1;
}

export function registerServeCommand(program: Command): void {
  const serve = program
    .command('serve')
    .description('Serve the web UI and local API')
    .option('--host <host>', 'interface to bind', '127.0.0.1')
    .option('--port <port>', 'port to listen on', '8080')
    .option('-d, --detached', 'run the server in the background', false)
    .action(async (options: ServeOptions) => {
      const host = options.host ?? '127.0.0.1';
      const requestedPort = Number(options.port ?? '8080');
      if (
        !Number.isInteger(requestedPort) ||
        requestedPort < 0 ||
        requestedPort > 65535
      ) {
        throw new Error(`Invalid port: ${options.port}`);
      }

      if (options.detached) {
        // Verify a recorded server before trusting it: after a host reboot the
        // pid is stale but the file persists, and blindly spawning a second
        // child would fail on the busy port (or, worse, resolve on a stale
        // entry). A live entry means "already serving"; a dead one is cleared
        // so a fresh server takes over cleanly (security/attack-surface.md, Zone 4).
        const existing = readServeState();
        if (existing && (await shouldReuseDetachedServe(existing))) {
          log.info(
            `UI already serving at http://${existing.host}:${existing.port}`
          );
          return;
        }
        if (existing) {
          removeServeState();
          log.info('Removed stale detached UI server state');
        }
        await startDetachedServe();
        log.info('UI server started in background');
        return;
      }

      // The BFF and the embed proxy (BFF port + 1) only work as a pair, so a
      // busy port on either side moves both to the nearest free pair.
      const port = await resolveFreePortBlock(requestedPort, 2, { host });
      if (port !== requestedPort) {
        log.warn(
          `Port ${requestedPort} or ${omniRouteEmbedPortFor(requestedPort)} is in use, using ${port} instead`
        );
      }
      const embedPort = omniRouteEmbedPortFor(port);
      // The browser terminal attaches to run containers through the engine
      // socket; without one the routes still answer, but a start is refused
      // with a clear message.
      const engineSocket = resolveEngineSocketPath();
      const terminal = new TerminalSessions({
        engine: engineSocket
          ? new UnixSocketEngineApi(engineSocket)
          : undefined,
      });
      if (!engineSocket) {
        log.warn(
          "No container engine socket found; the browser terminal cannot start runs. Set DOCKER_HOST (unix:// or npipe://) or CONTAINER_HOST to your engine's socket if it lives somewhere unusual."
        );
      }
      // e as an A2A agent (ADR-0015): open on loopback, bearer-protected
      // with E_A2A_TOKEN, off beyond loopback without one.
      const access = a2aAccess({ host, token: env.a2aToken });
      if (!access.enabled) log.warn(`A2A endpoint disabled: ${access.reason}`);
      const worktreesDir = defaultWorktreesDir();
      const a2aSpool = a2aSpoolDirFor(worktreesDir, process.pid);
      const tasks = new A2aTasks({
        spoolDir: a2aSpool,
        knownAgent: name =>
          Object.keys(HARNESSES).includes(name) ||
          storeAgents().some(
            agent => agent.name === name && agent.transport !== 'a2a'
          ),
        defaultAgent: readConfig(findRoot()).defaultHarness,
      });
      const app = createServeApp(resolveUiDirectory(), {
        omniRouteEmbedPort: embedPort,
        terminal,
        a2a: {
          tasks,
          access,
          url: `http://${host}:${port}${A2A_RPC_PATH}`,
        },
        worktreesDir,
      });
      const server = await startServeServer(app, host, port);
      attachTerminalWebSocket(server, terminal);
      const embedProxy = await startOmniRouteEmbedProxy(host, embedPort);
      server.once('close', () => {
        embedProxy.close();
        terminal.dispose();
        tasks.dispose();
        removeA2aSpool(a2aSpool);
      });
      const address = server.address() as AddressInfo;
      if (env.serveDetached) {
        trackDetachedServer(server, host, address.port);
      }
      log.info(`UI serving at http://${host}:${address.port}`);
      log.info(`OmniRoute embed proxy at http://${host}:${embedPort}`);
      if (access.enabled) {
        log.info(
          `A2A agent card at http://${host}:${address.port}${AGENT_CARD_PATH}${access.requireBearer ? ' (bearer token required on the endpoint)' : ''}`
        );
      }
    });

  serve
    .command('stop')
    .description('Stop the detached web UI server')
    .action(() => stopDetachedServe());
}
