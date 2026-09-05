import express, { type Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Command } from 'commander';
import { resolveUiDirectory } from './assets';
import { log } from './utils/log';

export interface ServeOptions {
  host?: string;
  port?: string;
}

export function createServeApp(uiDirectory: string): Express {
  const app = express();

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.get('/api/info', (_request, response) => {
    response.json({ name: 'e', version: '1.0.0' });
  });

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

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Serve the web UI and local API')
    .option('--host <host>', 'interface to bind', '127.0.0.1')
    .option('--port <port>', 'port to listen on', '8080')
    .action(async (options: ServeOptions) => {
      const host = options.host ?? '127.0.0.1';
      const port = Number(options.port ?? '8080');
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid port: ${options.port}`);
      }

      const app = createServeApp(resolveUiDirectory());
      const server = await startServeServer(app, host, port);
      const address = server.address() as AddressInfo;
      log.info(`UI serving at http://${host}:${address.port}`);
    });
}
