/**
 * **The detached `e serve` lifecycle**: the `serve.json` entry under the
 * Store's base dir that records where a background BFF listens, and the
 * respawn path that puts one there.
 *
 * The entry is a claim, not a fact. A host reboot leaves a file whose pid
 * belongs to nobody and whose port answers nothing, so nothing here trusts it
 * without asking both the OS (`process.kill(pid, 0)`) and the port
 * (`/api/health`) - blindly spawning a second child would either fail on the
 * busy port or, worse, resolve against a stale entry
 * (`docs/security/attack-surface.md`, Zone 4).
 *
 * Every side effect the decision depends on - reading the entry, clearing it,
 * spawning the child, the clock it polls against - arrives through
 * {@link DetachedServeDeps}, so the reuse-or-respawn path is testable without
 * ever starting a server.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import { eBaseDir } from '../../core/store/paths.js';
import { env } from '../../shared/utils/env.js';
import { log } from '../../shared/utils/log.js';
import { selfInvocation } from '../../shared/utils/selfInvoke.js';

/** Where the background server records itself, next to the rest of the Store's state. */
const serveStatePath = (): string => path.join(eBaseDir(), 'serve.json');

/** How long the background child has to record its entry before we give up. */
const READY_TIMEOUT_MS = 5000;

/** How often to look for that entry while waiting. */
const READY_POLL_MS = 50;

/** The recorded detached server: who it is and where it listens. */
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

/** The slice of a spawned child the respawn path drives; tests fake it. */
export interface DetachedChild {
  once(event: 'error', listener: (error: Error) => void): unknown;
  unref(): void;
}

export interface DetachedServeDeps extends ServeProbes {
  /** Reads the recorded entry; defaults to `serve.json` in the Store's base dir. */
  readState?: () => ServeState | undefined;
  /** Forgets the recorded entry; defaults to unlinking that file. */
  clearState?: () => void;
  /** Starts the background child; defaults to a detached re-invocation of this CLI. */
  spawnChild?: () => DetachedChild;
  /** How long to wait for the child to record its entry. */
  readyTimeoutMs?: number;
  /** How often to look for it. */
  pollMs?: number;
}

/** What {@link ensureDetachedServe} did, so the caller only has to say it. */
export type DetachedServeOutcome =
  | { reused: true; state: ServeState }
  | { reused: false; clearedStale: boolean };

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

export function writeServeState(state: ServeState): void {
  const target = serveStatePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporaryPath = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`);
  fs.renameSync(temporaryPath, target);
}

export function removeServeState(): void {
  try {
    fs.unlinkSync(serveStatePath());
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

export function readServeState(): ServeState | undefined {
  try {
    const state = JSON.parse(
      fs.readFileSync(serveStatePath(), 'utf8')
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

/** Re-invokes this very CLI as a detached, output-less `serve` child. */
function spawnDetachedChild(): DetachedChild {
  const { command } = selfInvocation();
  return spawn(command, detachedServeArguments(process.argv), {
    detached: true,
    stdio: 'ignore',
    env: env.withServeDetached(),
  });
}

/**
 * Starts the background child and resolves once it has recorded its entry.
 * The child is the only thing that can say it is ready - it picks the final
 * port - so readiness is a poll of `serve.json` against a deadline rather than
 * anything the parent observes directly.
 */
export function startDetachedServe(
  deps: DetachedServeDeps = {}
): Promise<void> {
  const readState = deps.readState ?? readServeState;
  const readyTimeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? READY_POLL_MS;
  const child = (deps.spawnChild ?? spawnDetachedChild)();
  child.unref();
  return new Promise((resolve, reject) => {
    // Whichever outcome lands first also stops the poll: a spawn error must
    // not leave a timer re-arming itself until the deadline.
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      finish();
    };
    // A spawn failure (bad execPath, EMFILE) would otherwise only surface as
    // the generic "did not become ready" timeout below.
    child.once('error', error =>
      settle(() =>
        reject(
          new Error(`Could not start the detached UI server: ${error.message}`)
        )
      )
    );
    const deadline = Date.now() + readyTimeoutMs;
    const checkState = (): void => {
      if (settled) return;
      if (readState()) {
        settle(resolve);
        return;
      }
      if (Date.now() >= deadline) {
        settle(() =>
          reject(new Error('Detached UI server did not become ready'))
        );
        return;
      }
      setTimeout(checkState, pollMs);
    };
    checkState();
  });
}

/**
 * The whole `serve --detached` decision: reuse the recorded server when it is
 * verified live, otherwise forget a stale entry and respawn. Returns what
 * happened instead of logging it, so the command owns the wording and this
 * module owns the rule.
 */
export async function ensureDetachedServe(
  deps: DetachedServeDeps = {}
): Promise<DetachedServeOutcome> {
  const existing = (deps.readState ?? readServeState)();
  if (existing && (await shouldReuseDetachedServe(existing, deps))) {
    return { reused: true, state: existing };
  }
  // A dead entry is cleared before respawning so the fresh server can record
  // itself over it cleanly.
  if (existing) (deps.clearState ?? removeServeState)();
  await startDetachedServe(deps);
  return { reused: false, clearedStale: existing !== undefined };
}

/** `e serve stop`: signal the recorded server, or clean up after one that is already gone. */
export function stopDetachedServe(): void {
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

/**
 * Records this process as *the* detached server and keeps the entry honest:
 * it goes away when the listener closes, and a signal closes the listener
 * first so the entry never outlives the port.
 */
export function trackDetachedServer(
  server: Server,
  host: string,
  port: number
): void {
  writeServeState({ pid: process.pid, host, port });
  server.once('close', removeServeState);
  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
