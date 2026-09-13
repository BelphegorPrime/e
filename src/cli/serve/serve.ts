/**
 * **`e serve` command wiring**: flags, ports, and the objects that only a real
 * server needs - the engine socket behind the browser terminal, the A2A
 * facade's tasks and their spool, the OmniRoute embed listener, and the
 * teardown that ties all of them to the BFF's own `close`.
 *
 * The BFF itself is `serveApp.ts`, the reverse proxies are `reverseProxy.ts`,
 * and the detached lifecycle is `detachedServe.ts`; this module just decides
 * what to hand them and what to log.
 */

import type { Command } from 'commander';
import type { AddressInfo } from 'node:net';

import { HARNESSES } from '../../core/harness/index.js';
import { readConfig } from '../../core/store/config.js';
import { findRoot } from '../../core/store/root.js';
import { a2aAccess } from '../../engine/a2a/access.js';
import {
  A2aTasks,
  a2aSpoolDirFor,
  removeA2aSpool,
} from '../../engine/a2a/tasks.js';
import { AGENT_CARD_PATH } from '../../engine/a2a/wire.js';
import { defaultWorktreesDir } from '../../engine/runs/worktreesDir.js';
import { env } from '../../shared/utils/env.js';
import { log } from '../../shared/utils/log.js';
import { resolveFreePortBlock } from '../../shared/utils/port.js';
import { resolveUiDirectory } from './assets.js';
import {
  resolveEngineSocketPath,
  UnixSocketEngineApi,
} from './containerApi.js';
import {
  ensureDetachedServe,
  stopDetachedServe,
  trackDetachedServer,
} from './detachedServe.js';
import {
  omniRouteEmbedPortFor,
  startOmniRouteEmbedProxy,
} from './reverseProxy.js';
import {
  A2A_RPC_PATH,
  createServeApp,
  startServeServer,
  storeAgents,
} from './serveApp.js';
import { TerminalSessions } from './terminalSessions.js';
import { attachTerminalWebSocket } from './terminalSocket.js';

export interface ServeOptions {
  host?: string;
  port?: string;
  detached?: boolean;
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
        const outcome = await ensureDetachedServe();
        if (outcome.reused) {
          log.info(
            `UI already serving at http://${outcome.state.host}:${outcome.state.port}`
          );
          return;
        }
        if (outcome.clearedStale) {
          log.info('Removed stale detached UI server state');
        }
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
      const app = createServeApp({
        uiDirectory: resolveUiDirectory(),
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
