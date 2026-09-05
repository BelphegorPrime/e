import express, { type Express } from 'express';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Command } from 'commander';
import { resolveUiDirectory } from './assets';
import { eBaseDir } from './store';
import { log } from './utils/log';

const SERVE_STATE_ENV = 'E_SERVE_DETACHED';
const serveStatePath = path.join(eBaseDir(), 'serve.json');

interface ServeState {
  pid: number;
  host: string;
  port: number;
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

export function detachedServeArguments(argv: string[]): string[] {
  return argv
    .slice(1)
    .filter(argument => argument !== '--detached' && argument !== '-d');
}

function startDetachedServe(): Promise<void> {
  const child = spawn(process.execPath, detachedServeArguments(process.argv), {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, [SERVE_STATE_ENV]: '1' },
  });
  child.unref();
  return new Promise((resolve, reject) => {
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
    const state = JSON.parse(fs.readFileSync(serveStatePath, 'utf8')) as Partial<ServeState>;
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
    log.info(`Stopping detached UI server on http://${state.host}:${state.port}`);
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
  const serve = program
    .command('serve')
    .description('Serve the web UI and local API')
    .option('--host <host>', 'interface to bind', '127.0.0.1')
    .option('--port <port>', 'port to listen on', '8080')
    .option('-d, --detached', 'run the server in the background', false)
    .action(async (options: ServeOptions) => {
      const host = options.host ?? '127.0.0.1';
      const port = Number(options.port ?? '8080');
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid port: ${options.port}`);
      }

      if (options.detached) {
        await startDetachedServe();
        log.info('UI server started in background');
        return;
      }

      const app = createServeApp(resolveUiDirectory());
      const server = await startServeServer(app, host, port);
      const address = server.address() as AddressInfo;
      if (process.env[SERVE_STATE_ENV] === '1') {
        trackDetachedServer(server, host, address.port);
      }
      log.info(`UI serving at http://${host}:${address.port}`);
    });

  serve
    .command('stop')
    .description('Stop the detached web UI server')
    .action(() => stopDetachedServe());
}
