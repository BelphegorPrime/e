/**
 * **The BFF's app assembly** (ADR-0010): the one place that says which routes
 * exist, in which order, and what each of them is wired to. Nothing here reads
 * git, a Spool or a container - `runsApi.ts`, `reverseProxy.ts`,
 * `terminalSessions.ts` and `engine/a2a/` own that - so a route is a status
 * code and a delegation, and every collaborator arrives through
 * {@link ServeAppDeps}.
 *
 * That includes `uiDirectory`: serving the built assets is one concern among
 * the others, not the app's identity, so a BFF that only answers `/api` is
 * just a `createServeApp({})` - which is why no test here needs a temp
 * directory to reach an API route.
 */

import express, { type Express } from 'express';
import type { Server } from 'node:http';

import {
  isRemoteAgent,
  listAgents as listStoreAgents,
} from '../../core/agent/index.js';
import { readConfig } from '../../core/store/config.js';
import { findRoot } from '../../core/store/root.js';
import type { A2aAccess } from '../../engine/a2a/access.js';
import { renderAgentCard } from '../../engine/a2a/agentCard.js';
import {
  a2aRpcHandler,
  agentCardHandler,
  type A2aServerDeps,
} from '../../engine/a2a/server.js';
import type { A2aTasks } from '../../engine/a2a/tasks.js';
import { AGENT_CARD_PATH } from '../../engine/a2a/wire.js';
import { defaultWorktreesDir } from '../../engine/runs/worktreesDir.js';
import type { Git } from '../../ports/git/index.js';
import { HostGit } from '../../ports/git/host.js';
import { env } from '../../shared/utils/env.js';
import { E_VERSION } from '../../shared/version.js';
import { respondJson, respondNotFound } from './apiResponse.js';
import { egressRoutes } from './reverseProxy.js';
import { RunsApi, runsRoutes } from './runsApi.js';
import { TerminalRequestError, TerminalSessions } from './terminalSessions.js';

/** The JSON-RPC endpoint of the A2A facade (ADR-0015), outside `/api` so the card can name it plainly. */
export const A2A_RPC_PATH = '/a2a';

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

/** Dependency injection point for the BFF's live views (ADR-0010). */
export interface ServeAppDeps {
  /**
   * The built UI assets to serve (`dist/ui`). Absent in tests and in any BFF
   * that only answers the API; the app then registers no static route and no
   * SPA fallback, so nothing but `/api` and the A2A paths exist.
   */
  uiDirectory?: string;
  /** Base URL of the egress container API (ADR-0012), e.g. `http://127.0.0.1:20129`. */
  egressApiUrl?: string;
  /**
   * Loopback port of the OmniRoute embed proxy (see `startOmniRouteEmbedProxy`),
   * published via `/api/info` so the UI can frame the dashboard. `null` when
   * the proxy is not running (tests, or a BFF started without it).
   */
  omniRouteEmbedPort?: number | null;
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

/** The A2A handlers' deps: live when configured and allowed, otherwise the reason the endpoint is off. */
function a2aServerDeps(
  a2a: ServeAppDeps['a2a'],
  listAgents: () => AgentSummary[]
): A2aServerDeps {
  if (a2a === undefined) {
    return {
      access: {
        enabled: false,
        reason: 'The A2A endpoint is not configured.',
      },
    };
  }
  const { access } = a2a;
  if (!access.enabled) return { access };
  return {
    access,
    tasks: a2a.tasks,
    card: () =>
      renderAgentCard({
        url: a2a.url,
        version: E_VERSION,
        // Remote A2A agents are not offered: that would be proxying.
        agents: listAgents().filter(agent => agent.transport !== 'a2a'),
        bearer: access.requireBearer,
      }),
  };
}

/** The Store's agents, as the UI's picker needs them. */
export function storeAgents(): AgentSummary[] {
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

/** A rejected terminal request is the caller's fault, with the status this route gives it. */
const terminalRequestStatus =
  (status: number) =>
  (error: unknown): number | undefined =>
    error instanceof TerminalRequestError ? status : undefined;

/** The request's `skills`/`mcp` field: an array of strings, or absent. */
function toNameList(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}

export function createServeApp(deps: ServeAppDeps = {}): Express {
  const {
    uiDirectory,
    egressApiUrl = env.egressApiUrl,
    omniRouteEmbedPort = null,
    git = new HostGit(),
    terminal,
    listAgents = storeAgents,
    a2a,
    worktreesDir = defaultWorktreesDir(),
  } = deps;

  const app = express();

  // Ahead of the body parser on purpose: the egress proxy streams the request
  // through untouched (ADR-0012), and a parsed body would have to be
  // re-serialized to get there.
  app.use(egressRoutes(egressApiUrl));
  app.use('/api', express.json());

  // e as an A2A agent (ADR-0015): the card at its well-known path, one
  // JSON-RPC endpoint. Both are delegations - a task is `e spawn` in a
  // headless child - so the BFF still holds no orchestration of its own.
  const a2aDeps = a2aServerDeps(a2a, listAgents);
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
    respondJson(response, () => ({
      agents: [...listAgents()].sort((a, b) => {
        if (a.default && !b.default) return -1;
        if (!a.default && b.default) return 1;
        return 0;
      }),
    }));
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

  app.get('/api/terminal/options', (_request, response) => {
    const sessions = requireTerminal(response);
    if (sessions) response.json(sessions.options());
  });

  app.get('/api/terminal/sessions', (_request, response) => {
    const sessions = requireTerminal(response);
    if (sessions) response.json({ sessions: sessions.list() });
  });

  app.post('/api/terminal/sessions', (request, response) => {
    const sessions = requireTerminal(response);
    if (!sessions) return;
    const body = (request.body ?? {}) as {
      agent?: unknown;
      name?: unknown;
      skills?: unknown;
      mcp?: unknown;
    };
    respondJson(
      response,
      () => ({
        session: sessions.start({
          agent: typeof body.agent === 'string' ? body.agent : '',
          name: typeof body.name === 'string' ? body.name : undefined,
          skills: toNameList(body.skills),
          mcp: toNameList(body.mcp),
        }),
      }),
      { status: 201, statusFor: terminalRequestStatus(400) }
    );
  });

  app.get('/api/terminal/sessions/:id', (request, response) => {
    const sessions = requireTerminal(response);
    if (!sessions) return;
    const session = sessions.get(request.params.id);
    if (!session) {
      respondNotFound(response);
      return;
    }
    response.json({ session });
  });

  app.delete('/api/terminal/sessions/:id', (request, response) => {
    const sessions = requireTerminal(response);
    if (!sessions) return;
    // A running session refuses removal: that is a 409, not a BFF failure.
    respondJson(response, () => sessions.remove(request.params.id), {
      statusFor: terminalRequestStatus(409),
    });
  });

  // Branch-backed runs index (ADR-0010): runs _are_ git branches
  // (`e/<agent>/<slug>-N` per ADR-0003), so everything behind these routes
  // reads git and the run's spool - see `runsApi.ts`.
  app.use(runsRoutes(new RunsApi({ git, worktreesDir })));

  app.use('/api', (_request, response) => {
    respondNotFound(response);
  });

  if (uiDirectory !== undefined) {
    app.use(express.static(uiDirectory));
    app.get('/{*splat}', (_request, response) => {
      response.sendFile('index.html', { root: uiDirectory });
    });
  }

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
