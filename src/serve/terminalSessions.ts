import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Duplex, Readable } from 'node:stream';
import type { EngineApi } from './containerApi.js';
import { runContainerPattern } from './containerApi.js';
import { env } from '../utils/env.js';
import { log } from '../utils/log.js';
import { selfInvocation } from '../utils/selfInvoke.js';

/**
 * Lifecycle of a browser-started run (ADR-0014):
 *  - `starting`: the `e spawn` child is building images, creating the
 *    worktree and starting the container; its stdout/stderr is the terminal.
 *  - `attached`: the container's TTY is hijacked; the harness is the terminal.
 *  - `exited`: the child finished (commit, push, PR); `exitCode` is its code.
 */
export type TerminalPhase = 'starting' | 'attached' | 'exited';

export interface TerminalSessionInfo {
  id: string;
  agent: string;
  /** The run name passed as `--name`; the run branch is `e/<agent>/<slug>-N`. */
  slug: string;
  phase: TerminalPhase;
  containerName?: string;
  exitCode?: number;
  createdAt: string;
}

export interface StartSessionRequest {
  agent: string;
  /** Optional run name; a unique `ui-…` slug is generated when absent. */
  name?: string;
}

export type TerminalControlMessage =
  | { type: 'status'; session: TerminalSessionInfo }
  | { type: 'error'; message: string };

/** One connected browser tab. */
export interface TerminalClient {
  /** Raw terminal bytes to render. */
  write(data: Buffer): void;
  /** A control message (phase changes, errors). */
  control(message: TerminalControlMessage): void;
}

/** The slice of `ChildProcess` a session drives; tests fake it. */
export interface SpawnedChild {
  stdout: Readable | null;
  stderr: Readable | null;
  on(
    event: 'exit',
    listener: (code: number | null, signal: string | null) => void
  ): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface TerminalSessionsDeps {
  /** Engine API for attach/resize; `undefined` when no engine socket was found. */
  engine: EngineApi | undefined;
  /** Spawns `e <args>` headless; defaults to re-invoking this executable. */
  spawnChild?: (args: string[]) => SpawnedChild;
  /** How often to look for the run's container while `starting`. */
  pollIntervalMs?: number;
  /** Replay buffer cap per session, in bytes. */
  bufferLimit?: number;
  now?: () => Date;
}

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const RUN_NAME = /^[a-z0-9][a-z0-9-]*$/;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_BUFFER_LIMIT = 512 * 1024;

/** Error whose message is safe to show the UI (a 400, not a 500). */
export class TerminalRequestError extends Error {}

/** Re-invokes this very CLI, the way the detached `serve` child does. */
function spawnHeadlessCli(args: string[]): SpawnedChild {
  const { command, prefix } = selfInvocation();
  return spawn(command, [...prefix, ...args], {
    cwd: process.cwd(),
    env: env.withHeadlessTty(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Line output from a non-TTY child needs carriage returns for a terminal. */
function toTerminalLines(chunk: Buffer | string): Buffer {
  return Buffer.from(chunk.toString().replace(/\r?\n/g, '\r\n'));
}

class TerminalSession {
  readonly clients = new Set<TerminalClient>();
  private readonly buffer: Buffer[] = [];
  private buffered = 0;
  private attachStream: Duplex | undefined;
  private pendingResize: { cols: number; rows: number } | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private polling = false;
  private attachFailureLogged = false;

  constructor(
    readonly info: TerminalSessionInfo,
    private readonly child: SpawnedChild,
    private readonly deps: Required<
      Pick<TerminalSessionsDeps, 'pollIntervalMs' | 'bufferLimit'>
    > &
      Pick<TerminalSessionsDeps, 'engine'>
  ) {
    child.stdout?.on('data', chunk => this.emit(toTerminalLines(chunk)));
    child.stderr?.on('data', chunk => this.emit(toTerminalLines(chunk)));
    child.on('error', error => {
      this.emit(toTerminalLines(`e spawn could not start: ${error.message}\n`));
      this.finish(1);
    });
    child.on('exit', (code, signal) => this.finish(signal ? 1 : (code ?? 0)));
    this.pollTimer = setInterval(
      () => void this.poll(),
      this.deps.pollIntervalMs
    );
  }

  attachClient(client: TerminalClient): () => void {
    this.clients.add(client);
    if (this.buffered > 0) client.write(Buffer.concat(this.buffer));
    client.control({ type: 'status', session: this.info });
    return () => {
      this.clients.delete(client);
    };
  }

  input(data: Buffer): void {
    this.attachStream?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pendingResize = { cols, rows };
    if (this.info.phase === 'attached' && this.info.containerName) {
      this.deps.engine
        ?.resize(this.info.containerName, cols, rows)
        .catch(() => {
          // A resize racing the container's exit is harmless.
        });
    }
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.attachStream?.destroy();
    this.attachStream = undefined;
  }

  private emit(data: Buffer): void {
    this.buffer.push(data);
    this.buffered += data.length;
    while (this.buffered > this.deps.bufferLimit && this.buffer.length > 1) {
      this.buffered -= this.buffer.shift()?.length ?? 0;
    }
    for (const client of this.clients) client.write(data);
  }

  private broadcast(message: TerminalControlMessage): void {
    for (const client of this.clients) client.control(message);
  }

  private async poll(): Promise<void> {
    if (this.polling || this.info.phase !== 'starting' || !this.deps.engine) {
      return;
    }
    this.polling = true;
    try {
      const container = await this.deps.engine.findContainer(
        runContainerPattern(this.info.agent, this.info.slug)
      );
      if (!container || this.info.phase !== 'starting') return;
      const stream = await this.deps.engine.attach(container.name);
      if (this.info.phase !== 'starting') {
        stream.destroy();
        return;
      }
      this.attachStream = stream;
      this.info.phase = 'attached';
      this.info.containerName = container.name;
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = undefined;
      stream.on('data', (chunk: Buffer) => this.emit(chunk));
      stream.on('error', () => undefined);
      stream.on('close', () => {
        if (this.attachStream === stream) this.attachStream = undefined;
      });
      if (this.pendingResize) {
        this.resize(this.pendingResize.cols, this.pendingResize.rows);
      }
      this.broadcast({ type: 'status', session: this.info });
    } catch (error) {
      if (!this.attachFailureLogged) {
        this.attachFailureLogged = true;
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`Terminal session ${this.info.id}: ${message}`);
        this.broadcast({ type: 'error', message });
      }
    } finally {
      this.polling = false;
    }
  }

  private finish(exitCode: number): void {
    if (this.info.phase === 'exited') return;
    this.info.phase = 'exited';
    this.info.exitCode = exitCode;
    this.dispose();
    this.broadcast({ type: 'status', session: this.info });
  }
}

/**
 * Browser-started runs (ADR-0014). Each session is one headless `e spawn`
 * child: the same orchestration as the CLI (worktree, sidecars, commit and
 * push after the harness exits), with its container's TTY hijacked through
 * the engine API and multiplexed to any number of browser tabs. Sessions live
 * in this process only; a run outlives `serve` (the child and the container
 * are not tied to it), but its terminal view does not.
 */
export class TerminalSessions {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly engine: EngineApi | undefined;
  private readonly spawnChild: (args: string[]) => SpawnedChild;
  private readonly pollIntervalMs: number;
  private readonly bufferLimit: number;
  private readonly now: () => Date;

  constructor(deps: TerminalSessionsDeps) {
    this.engine = deps.engine;
    this.spawnChild = deps.spawnChild ?? spawnHeadlessCli;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.bufferLimit = deps.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
    this.now = deps.now ?? (() => new Date());
  }

  /** False when no engine socket was found: sessions cannot be started. */
  get engineAvailable(): boolean {
    return this.engine !== undefined;
  }

  start(request: StartSessionRequest): TerminalSessionInfo {
    if (!this.engine) {
      throw new TerminalRequestError(
        'No container engine socket found; the browser terminal needs the Docker socket (or the Podman service socket).'
      );
    }
    if (typeof request.agent !== 'string' || !AGENT_NAME.test(request.agent)) {
      throw new TerminalRequestError('A valid agent name is required.');
    }
    const slug =
      request.name === undefined || request.name === ''
        ? `ui-${this.now().getTime().toString(36)}`
        : request.name;
    if (typeof slug !== 'string' || !RUN_NAME.test(slug)) {
      throw new TerminalRequestError(
        'Run names may contain lowercase letters, digits and hyphens only.'
      );
    }
    const info: TerminalSessionInfo = {
      id: randomUUID(),
      agent: request.agent,
      slug,
      phase: 'starting',
      createdAt: this.now().toISOString(),
    };
    const child = this.spawnChild(['spawn', request.agent, '--name', slug]);
    this.sessions.set(
      info.id,
      new TerminalSession(info, child, {
        engine: this.engine,
        pollIntervalMs: this.pollIntervalMs,
        bufferLimit: this.bufferLimit,
      })
    );
    return info;
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()]
      .map(session => session.info)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): TerminalSessionInfo | undefined {
    return this.sessions.get(id)?.info;
  }

  /** Subscribes a client; replays the buffer, then streams. Returns the unsubscribe. */
  attachClient(id: string, client: TerminalClient): (() => void) | undefined {
    return this.sessions.get(id)?.attachClient(client);
  }

  input(id: string, data: Buffer): void {
    this.sessions.get(id)?.input(data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
    if (cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return;
    this.sessions.get(id)?.resize(cols, rows);
  }

  /** Forgets an exited session. Throws while the run is still going. */
  remove(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.info.phase !== 'exited') {
      throw new TerminalRequestError(
        'The run is still going; exit the harness first.'
      );
    }
    session.dispose();
    this.sessions.delete(id);
  }

  /** Stops timers and attach streams. The runs themselves keep going. */
  dispose(): void {
    for (const session of this.sessions.values()) session.dispose();
  }
}
