/**
 * **`e serve` command wiring**: flags, ports, and the objects that only a real
 * server needs - the engine socket behind the browser terminal, the A2A
 * facade's tasks and their spool, the OmniRoute embed listener, the webhook
 * listener, and the teardown that ties all of them to the BFF's own `close`.
 *
 * The BFF itself is `serveApp.ts`, the reverse proxies are `reverseProxy.ts`,
 * the webhook listener is `webhookServer.ts`, and the detached lifecycle is
 * `detachedServe.ts`; this module just decides what to hand them and what to
 * log.
 */

import type { Command } from 'commander';
import type { AddressInfo } from 'node:net';

import { HARNESSES } from '../../core/harness/index.js';
import { readConfig } from '../../core/store/config.js';
import { findRoot } from '../../core/store/root.js';
import { eBaseDir, envFilePath } from '../../core/store/paths.js';
import { storeTriggerContext } from '../../core/trigger/context.js';
import { loadTriggers } from '../../core/trigger/load.js';
import { RunQueue } from '../../engine/queue/runQueue.js';
import { runsDirs } from '../../engine/queue/runsSpool.js';
import { resolveRuntime } from '../../ports/runtime/registry.js';
import { errorMessage } from '../../shared/utils/errors.js';
import { a2aAccess } from '../../engine/a2a/access.js';
import {
  A2aTasks,
  a2aSpoolDirFor,
  removeA2aSpool,
} from '../../engine/a2a/tasks.js';
import { AGENT_CARD_PATH } from '../../engine/a2a/wire.js';
import { defaultWorktreesDir } from '../../engine/runs/worktreesDir.js';
import { env } from '../../shared/utils/env.js';
import { readDotenvFile } from '../../shared/utils/dotenv.js';
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
import { openWebhookListener, webhookPortFor } from './webhookServer.js';

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

      // The BFF, the embed proxy (BFF port + 1) and the webhook listener
      // (BFF port + 2) are one block, so a busy port on any of them moves all
      // three to the nearest free block.
      const port = await resolveFreePortBlock(requestedPort, 3, { host });
      if (port !== requestedPort) {
        log.warn(
          `Port ${requestedPort}, ${omniRouteEmbedPortFor(requestedPort)} or ${webhookPortFor(requestedPort)} is in use, using ${port} instead`
        );
      }
      const embedPort = omniRouteEmbedPortFor(port);
      const webhookPort = webhookPortFor(port);
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
      // The hosted shape's spine (ADR-0016 section 6): the queue, the ledger
      // and the tick. The webhook listener enqueues onto it (the scheduler
      // will too); every `e spawn` already writes the ledger.
      const root = findRoot();
      const storeDir = eBaseDir(root);
      const runs = runsDirs(storeDir);
      let queue: RunQueue | undefined;
      try {
        const runtime = resolveRuntime();
        queue = new RunQueue({
          dirs: runs,
          config: readConfig(findRoot()).queue,
          containerRunning: name => runtime.isRunning(name),
        });
      } catch (err) {
        log.warn(
          `Run queue disabled: ${errorMessage(err)}; nothing triggered can start.`
        );
      }
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
        runs,
      });
      const server = await startServeServer(app, host, port);
      // Only once serve is up: a serve that fails to start must not have
      // launched a run nobody can see.
      queue?.start();
      attachTerminalWebSocket(server, terminal);
      const embedProxy = await startOmniRouteEmbedProxy(host, embedPort);
      // The webhook listener (ADR-0016 section 7): its own port, so a tunnel
      // aimed at it cannot reach the BFF. The secret is read from the serving
      // Store's `.e/.env` at every verification, never from `process.env`,
      // which a detached restart would lose; with none the port stays closed.
      const storeEnvFile = envFilePath(root);
      const webhooks = await openWebhookListener({
        host,
        port: webhookPort,
        envFile: storeEnvFile,
        envValue: name => readDotenvFile(storeEnvFile)[name],
        triggers: () =>
          loadTriggers(root, storeTriggerContext(root)).flatMap(loaded =>
            loaded.trigger ? [loaded.trigger] : []
          ),
        queue,
      });
      if (!webhooks.server) log.warn(webhooks.warning);
      server.once('close', () => {
        embedProxy.close();
        webhooks.server?.close();
        terminal.dispose();
        tasks.dispose();
        removeA2aSpool(a2aSpool);
        queue?.stop();
      });
      const address = server.address() as AddressInfo;
      if (env.serveDetached) {
        trackDetachedServer(server, host, address.port);
      }
      log.info(`UI serving at http://${host}:${address.port}`);
      log.info(`OmniRoute embed proxy at http://${host}:${embedPort}`);
      if (webhooks.server) {
        for (const url of webhooks.urls) {
          log.info(`Webhook listener at ${url} (HMAC-signed deliveries only)`);
        }
      }
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
