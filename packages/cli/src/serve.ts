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
import { LOCAL_LLAMA_URL, type ModelsResponse } from './modelStatus';

const SERVE_STATE_ENV = 'E_SERVE_DETACHED';
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
 * whose port answers nothing — this is how we tell that entry apart.
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

/** Dependency injection point for the BFF's live llama.cpp views (ADR-0010). */
export interface ServeAppDeps {
  /** Base URL of the local llama.cpp router, e.g. `http://127.0.0.1:9931`. */
  llamaBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createServeApp(
  uiDirectory: string,
  deps: ServeAppDeps = {}
): Express {
  const { llamaBaseUrl = LOCAL_LLAMA_URL, fetchImpl = fetch } = deps;
  const app = express();

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.get('/api/info', (_request, response) => {
    response.json({ name: 'e', version: '1.0.0' });
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
