/**
 * The host side of sibling requests (ADR-0013, ticket 06). While a parent run
 * is in its container, the host process that started it polls the run's
 * spool: every request the runtime-broker accepted (`requests/<id>.json`) is
 * picked up once, checked against the depth and fan-out rules, and turned
 * into a sibling run by re-invoking this very CLI (`e spawn <agent>
 * --detached -- <prompt>`, the ADR-0014 pattern) with the sibling markers in
 * its environment. The sibling process runs the whole spawn pipeline itself -
 * plan, image, the checkpoint of the parent (ticket 04), the artifact sync
 * (ticket 05) - and writes its own status (`starting` with its branch as
 * soon as it has one, `running`, then `done` or `failed`) into the spool;
 * this consumer writes `starting` when it launches a process and `failed`
 * when a process never gets that far.
 *
 * Depth: every accepted request becomes a sibling under the parent that owns
 * the broker, never a child of a child; a spool whose run is itself a child
 * refuses. Fan-out: at most `maxSiblings` in flight (`starting` or `running`);
 * further requests wait in the spool and are picked up as slots free.
 * Readiness follows the sidecar policy's shape (ADR-0005): the spool is polled
 * every `intervalMs`, and a launched sibling has `attempts` polls to report
 * `running` before it is killed and failed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import { DEPTH_LIMIT_MESSAGE, SPOOL_LOGS_DIR } from '../broker/constants.js';
import {
  countInFlight,
  listRequestIds,
  readRequest,
  readStatus,
  writeStatus,
} from '../broker/spool.js';
import type { SpawnRequest } from '../broker/types.js';
import { env } from '../utils/env.js';
import { log } from '../utils/log.js';
import { selfInvocation, type SelfInvocation } from '../utils/selfInvoke.js';
import type { ReadinessPolicy } from './runSidecarOrchestrator.js';
import type { RunRole } from './runRole.js';

/** A launched sibling process, as the consumer sees it. */
export interface SiblingProcess {
  /** Resolves with the exit code once the process is gone (1 when it failed to start or was killed). */
  exited: Promise<number>;
  /** Asks the process to stop (a sibling that never became ready). */
  kill(): void;
}

/** What a launcher gets: the request, the CLI arguments, the environment carrying the markers, and where to log. */
export interface SiblingLaunch {
  request: SpawnRequest;
  /** The arguments after the executable (and its entry script): `spawn <agent> --detached ... -- <prompt>`. */
  args: string[];
  env: Record<string, string | undefined>;
  logFile: string;
}

/** Starts one sibling process; production re-invokes the CLI, tests script one. */
export type SiblingLauncher = (launch: SiblingLaunch) => SiblingProcess;

/**
 * Default pacing: poll every second, allow ten minutes for a sibling to reach
 * its container (a harness image may have to be built first). The shape is
 * the sidecar readiness policy's (ADR-0005): `intervalMs` between polls,
 * `attempts` polls before giving up.
 */
export const DEFAULT_SIBLING_READINESS: ReadinessPolicy = {
  attempts: 600,
  intervalMs: 1000,
};

/** Everything a {@link SiblingConsumer} needs. */
export interface SiblingConsumerOptions {
  /** The parent run's spool (the broker's bind mount). */
  spoolDir: string;
  /** The parent run: what a sibling checkpoints and branches from, and the network it joins. */
  parent: {
    worktreePath: string;
    branch: string;
    /** The parent's private run network, absent in the shared egress namespace. */
    network?: string;
    role: RunRole;
  };
  /** Fan-out bound: siblings in flight at once. */
  maxSiblings: number;
  /** Poll interval and the polls a launched sibling may take to report `running`. */
  readiness: ReadinessPolicy;
  /** `e spawn` arguments every sibling inherits from the parent's invocation (`--dir`, `--env-file`). */
  passthroughArgs?: string[];
  /** Environment every sibling process inherits beyond the markers (the parent's `E_RUNTIME`). */
  passthroughEnv?: Record<string, string>;
  launch: SiblingLauncher;
  sleep: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** The CLI arguments that spawn a sibling: `spawn <agent> --detached [passthrough...] -- <prompt>`. */
export function siblingCliArgs(
  request: SpawnRequest,
  passthrough: readonly string[] = []
): string[] {
  return [
    'spawn',
    request.agent,
    '--detached',
    ...passthrough,
    '--',
    request.prompt,
  ];
}

/**
 * `selfInvocation()` checked to really be the e CLI: with a script entry it
 * must be the CLI's `index.js` (a single executable has none). Re-invoking any
 * other entry - a test file, say - would run *that* as every "sibling", which
 * would spawn siblings of its own: a fork bomb. Better refused than tried.
 */
export function assertCliEntry(invocation: SelfInvocation): SelfInvocation {
  const [entry] = invocation.prefix;
  if (entry !== undefined && !/(^|[\\/])index\.(m?js|cjs)$/.test(entry)) {
    throw new Error(
      `Refusing to re-invoke "${entry}" as the e CLI: not its index.js entry`
    );
  }
  return invocation;
}

/**
 * The production launcher: re-invokes this CLI in the directory the parent
 * spawn was started from (the repo), output appended to the spool log.
 * `invocation` is how to run this CLI again (checked by {@link assertCliEntry}
 * by default); tests pass a scripted one.
 */
export function spawnSiblingProcess(
  launch: SiblingLaunch,
  invocation: SelfInvocation = assertCliEntry(selfInvocation())
): SiblingProcess {
  fs.mkdirSync(path.dirname(launch.logFile), { recursive: true });
  const out = fs.openSync(launch.logFile, 'a');
  let child;
  try {
    child = spawnProcess(
      invocation.command,
      [...invocation.prefix, ...launch.args],
      { cwd: process.cwd(), env: launch.env, stdio: ['ignore', out, out] }
    );
  } catch (err) {
    fs.closeSync(out);
    throw err;
  }
  const exited = new Promise<number>(resolve => {
    child.on('error', () => resolve(1));
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 0)));
  }).finally(() => fs.closeSync(out));
  return { exited, kill: () => child.kill('SIGTERM') };
}

/** The last `lines` of a sibling's log, joined, for a failure message; empty when there is none. */
export function logTail(logFile: string, lines = 3): string {
  try {
    const text = fs.readFileSync(logFile, 'utf8').trimEnd();
    return text === '' ? '' : text.split('\n').slice(-lines).join(' | ');
  } catch {
    return '';
  }
}

/**
 * Picks sibling requests up from a run's spool for as long as its agent runs
 * (see the module doc). Driven by {@link SiblingConsumer.start} in production
 * and tick by tick in tests.
 */
export class SiblingConsumer {
  private readonly inFlight = new Map<
    string,
    { child: SiblingProcess; polls: number; logFile: string }
  >();
  private stopping = false;
  private loop: Promise<void> | undefined;

  constructor(private readonly opts: SiblingConsumerOptions) {}

  /** Begins polling the spool; idempotent. */
  start(): void {
    if (!this.loop) this.loop = this.run();
  }

  /**
   * Stops picking requests up, fails the ones still waiting (the parent run
   * has ended; nobody is left to receive their work), waits for the siblings
   * in flight to exit, and fails whatever arrived while waiting.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    await (this.loop ?? Promise.resolve());
    this.failWaiting();
    await Promise.all(
      [...this.inFlight.values()].map(flight => flight.child.exited)
    );
    this.failWaiting();
  }

  private failWaiting(): void {
    for (const id of listRequestIds(this.opts.spoolDir)) {
      if (!readStatus(this.opts.spoolDir, id)) {
        this.fail(id, 'the parent run ended before the request was picked up');
      }
    }
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      this.tick();
      await this.opts.sleep(this.opts.readiness.intervalMs);
    }
  }

  /** One pass: new requests are refused, started, or left waiting; launched siblings are watched. */
  tick(): void {
    const { spoolDir, parent, maxSiblings } = this.opts;
    const launchedNow = new Set<string>();
    let inFlight = countInFlight(spoolDir, ['starting', 'running']);
    for (const id of listRequestIds(spoolDir)) {
      if (readStatus(spoolDir, id)) continue;
      const request = readRequest(spoolDir, id);
      if (!request) continue;
      if (parent.role === 'child') {
        this.fail(id, DEPTH_LIMIT_MESSAGE);
        continue;
      }
      // Arrival order: the first waiting request takes the next free slot.
      if (inFlight >= maxSiblings) break;
      this.launch(request);
      launchedNow.add(id);
      inFlight += 1;
    }
    // The readiness watch: polls start counting on the tick after the launch.
    for (const [id, flight] of this.inFlight) {
      if (launchedNow.has(id)) continue;
      if (readStatus(spoolDir, id)?.status !== 'starting') continue;
      flight.polls += 1;
      if (flight.polls >= this.opts.readiness.attempts) {
        flight.child.kill();
        this.inFlight.delete(id);
        this.fail(
          id,
          `did not become ready in time (no container after ${this.opts.readiness.attempts} polls)`
        );
      }
    }
  }

  private launch(request: SpawnRequest): void {
    const { spoolDir, parent } = this.opts;
    this.markStarting(request.id);
    log.info(
      `Sibling ${request.id}: starting ${request.agent} for ${parent.branch}`
    );
    const logFile = path.join(spoolDir, SPOOL_LOGS_DIR, `${request.id}.log`);
    let child: SiblingProcess;
    try {
      child = this.opts.launch({
        request,
        args: siblingCliArgs(request, this.opts.passthroughArgs),
        env: {
          ...env.withSibling({
            parent: {
              worktreePath: parent.worktreePath,
              branch: parent.branch,
              network: parent.network,
            },
            spoolDir,
            id: request.id,
          }),
          ...this.opts.passthroughEnv,
        },
        logFile,
      });
    } catch (err) {
      this.fail(
        request.id,
        `could not start the sibling process: ${(err as Error).message}`
      );
      return;
    }
    this.inFlight.set(request.id, { child, polls: 0, logFile });
    child.exited.then(
      code => this.onExit(request.id, code, logFile),
      err => this.onExit(request.id, 1, logFile, (err as Error).message)
    );
  }

  /** The sibling reports its own result; a process that never did has failed. */
  private onExit(
    id: string,
    code: number,
    logFile: string,
    reason?: string
  ): void {
    this.inFlight.delete(id);
    const status = readStatus(this.opts.spoolDir, id)?.status;
    if (status === 'done' || status === 'failed') return;
    const tail = logTail(logFile);
    this.fail(
      id,
      reason ??
        `sibling process exited with code ${code} before reporting a result${tail ? `: ${tail}` : ''}`,
      code
    );
  }

  private fail(id: string, error: string, exitCode?: number): void {
    log.warn(`Sibling ${id}: ${error}`);
    writeStatus(this.opts.spoolDir, id, {
      status: 'failed',
      error,
      ...(exitCode !== undefined ? { exitCode } : {}),
      updatedAt: this.now(),
    });
  }

  private markStarting(id: string): void {
    writeStatus(this.opts.spoolDir, id, {
      status: 'starting',
      updatedAt: this.now(),
    });
  }

  private now(): string {
    return (this.opts.now ?? (() => new Date()))().toISOString();
  }
}
