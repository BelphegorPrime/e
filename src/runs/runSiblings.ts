/**
 * The host side of sibling requests (ADR-0013, ticket 06). While a parent run
 * is in its container, the host process that started it polls the run's
 * spool: every request the runtime-broker accepted (`requests/<id>.json`) is
 * picked up once, checked against the depth and fan-out rules, and turned
 * into a sibling run by re-invoking this very CLI (`e spawn <agent>
 * -- <prompt>`, the ADR-0014 pattern) with the sibling markers in
 * its environment. The sibling process runs the whole spawn pipeline itself -
 * plan, image, the checkpoint of the parent (ticket 04), the artifact sync
 * (ticket 05) - and writes its own status (`starting` with its branch as
 * soon as it has one, `running`, then `done` or `failed`) into the spool;
 * this consumer writes `starting` when it launches a process and `failed`
 * when a process never gets that far.
 *
 * Depth: every accepted request becomes a sibling under the parent that owns
 * the broker, never a child of a child; a spool whose run is itself a child
 * **rejects** (ADR-0015). Fan-out: at most `maxSiblings` in flight
 * (`starting` or `running`); further requests wait in the spool and are
 * picked up as slots free. Readiness follows the sidecar policy's shape
 * (ADR-0005): the spool is polled every `intervalMs`, and a launched sibling
 * has `attempts` polls to report `running` before it is killed and failed.
 *
 * Cancel (ADR-0015, the A2A `tasks/cancel`): a `cancels/<id>.json` the broker
 * spooled for `POST /cancel/<id>` is taken on the next tick - a request not
 * yet started is marked `canceled` right away; one in flight gets its process
 * stopped (the `e spawn` child stops its container on SIGTERM) and is marked
 * `canceled` when it exits, whatever it reported last. The parent run's end
 * cancels what was still waiting. A remote A2A agent (ADR-0015) is launched
 * through the same launcher seam: no process, the host talks A2A in-process
 * and reports the answer.
 *
 * Merge-back (ticket 07): when a sibling process exits, its record is
 * **settled** - a `done` sibling that exited 0 is folded into the parent
 * worktree (`runMergeBack.ts`), anything else is skipped with the reason -
 * and the outcome is published twice: into the sibling's status (`merge`,
 * `report`) for `GET /status`, and as `e-runs/<id>/report.md` in the parent
 * worktree for the agent to read. A merge held over files in flight, or in
 * progress with conflict markers, waits for the parent's signal
 * (`POST /merge/<id>`, a file in the spool the tick takes) and is retried;
 * the parent run's end retries the held ones once more, after the parent's
 * own work is committed. A merge that lands frees every held one to retry.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import {
  DEPTH_LIMIT_MESSAGE,
  MERGE_SIGNAL_STATES,
  SPOOL_LOGS_DIR,
} from '../broker/constants.js';
import {
  countInFlight,
  listRequestIds,
  readRecord,
  readRequest,
  readStatus,
  takeCancelSignal,
  takeMergeSignal,
  writeStatus,
} from '../broker/spool.js';
import type {
  MergeBack,
  SiblingRecord,
  SiblingState,
  SpawnRequest,
} from '../broker/types.js';
import type { Git } from '../git/index.js';
import { env } from '../utils/env.js';
import {
  concludeMergeBack,
  mergeBackSibling,
  mergeLanded,
  writeSiblingReport,
} from './runMergeBack.js';
import { log } from '../utils/log.js';
import { selfInvocation, type SelfInvocation } from '../utils/selfInvoke.js';
import type { ReadinessPolicy } from './runSidecarOrchestrator.js';
import type { RunRole } from './runRole.js';

import { errorMessage } from '../utils/errors.js';
/** A launched sibling process, as the consumer sees it. */
export interface SiblingProcess {
  /** Resolves with the exit code once the process is gone (1 when it failed to start or was killed). */
  exited: Promise<number>;
  /** Asks the process to stop (a cancel, or a sibling that never became ready). */
  kill(): void;
}

/** What a launcher gets: the request, the CLI arguments, the environment carrying the markers, and where to log. */
export interface SiblingLaunch {
  request: SpawnRequest;
  /** The arguments after the executable (and its entry script): `spawn <agent> ... -- <prompt>`. */
  args: string[];
  env: Record<string, string | undefined>;
  logFile: string;
  /** The parent's spool, where the sibling reports its status under `request.id`. */
  spoolDir: string;
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
  /** The host's git, for the merge-back into the parent worktree. */
  git: Git;
}

/** The run states a settled sibling can be in (nothing more will happen to it). */
export type SettledState = Extract<
  SiblingState,
  'done' | 'failed' | 'canceled' | 'rejected'
>;

/** How one sibling ended and how its work reached the parent (ticket 07). */
export interface SiblingOutcome {
  id: string;
  agent: string;
  /** The sibling's run branch, once it had one. */
  branch?: string;
  status: SettledState;
  exitCode?: number;
  /** Why the sibling failed, was canceled or was rejected, when it was. */
  error?: string;
  /** The merge-back into the parent worktree. */
  merge: MergeBack;
  /** The report's path relative to the parent worktree (`e-runs/<id>/report.md`); absent if it could not be written. */
  report?: string;
}

/** One line per sibling for the run's summary: who, how it ended, how its work came back. */
export function siblingSummaryLine(outcome: SiblingOutcome): string {
  const who = `${outcome.agent}${outcome.branch ? `, ${outcome.branch}` : ''}`;
  const files = outcome.merge.files?.length
    ? ` [${outcome.merge.files.join(', ')}]`
    : '';
  const reason = outcome.merge.reason ? ` - ${outcome.merge.reason}` : '';
  return `Sibling ${outcome.id} (${who}): ${outcome.status}, merge-back ${outcome.merge.status}${files}${reason}`;
}

/** The CLI arguments that spawn a sibling: `spawn <agent> [passthrough...] -- <prompt>` (a prompt means one-shot). */
export function siblingCliArgs(
  request: SpawnRequest,
  passthrough: readonly string[] = []
): string[] {
  return ['spawn', request.agent, ...passthrough, '--', request.prompt];
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

/** Why a request the parent run outlived was canceled. */
export const PARENT_ENDED_MESSAGE =
  'the parent run ended before the request was picked up';

/** Why a canceled sibling is not merged. */
export const CANCELED_MESSAGE = 'canceled by the parent';

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
  /** Siblings whose process was asked to stop for a cancel; their exit is `canceled`. */
  private readonly canceling = new Set<string>();
  private stopping = false;
  private loop: Promise<void> | undefined;
  /** Every sibling that has exited, with its merge-back. */
  private readonly settled = new Map<string, SiblingOutcome>();

  constructor(private readonly opts: SiblingConsumerOptions) {}

  /** The siblings that have exited so far and how their work reached the parent, by id. */
  get outcomes(): SiblingOutcome[] {
    return [...this.settled.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Begins polling the spool; idempotent. */
  start(): void {
    if (!this.loop) this.loop = this.run();
  }

  /**
   * Stops picking requests up, cancels the ones still waiting (the parent run
   * has ended; nobody is left to receive their work), waits for the siblings
   * in flight to exit, and cancels whatever arrived while waiting.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    await (this.loop ?? Promise.resolve());
    this.cancelWaiting();
    await Promise.all(
      [...this.inFlight.values()].map(flight => flight.child.exited)
    );
    this.cancelWaiting();
  }

  /**
   * The parent run has ended and committed its own work (or had nothing to):
   * the last retry of every merge held over files in flight - the tree is
   * quiet now, so each lands or conflicts - and a conflict the parent's own
   * commit concluded (the commit with `MERGE_HEAD` set is the merge commit)
   * is reported merged. A conflict still in progress stays as it is: only
   * the parent could have resolved it.
   */
  finish(): void {
    for (const outcome of this.outcomes) {
      if (outcome.merge.status === 'held') {
        this.retry(outcome.id);
      } else if (
        outcome.merge.status === 'conflict' &&
        !this.opts.git.mergeInProgress(this.opts.parent.worktreePath)
      ) {
        const record = readRecord(this.opts.spoolDir, outcome.id);
        if (record) {
          this.publish(record, {
            status: 'merged',
            reason:
              "concluded by the run's final commit with the files as the agent left them; check them for leftover conflict markers",
          });
        }
      }
    }
  }

  private cancelWaiting(): void {
    for (const id of listRequestIds(this.opts.spoolDir)) {
      if (!readStatus(this.opts.spoolDir, id)) {
        this.end(id, 'canceled', PARENT_ENDED_MESSAGE);
        const record = readRecord(this.opts.spoolDir, id);
        if (record) this.settle(record);
      }
    }
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      this.tick();
      await this.opts.sleep(this.opts.readiness.intervalMs);
    }
  }

  /**
   * One pass: cancels are taken; new requests are rejected, started, or left
   * waiting; launched siblings are watched; merge-backs the parent signaled
   * are retried.
   */
  tick(): void {
    const { spoolDir, parent, maxSiblings } = this.opts;
    this.takeCancels();
    const launchedNow = new Set<string>();
    let inFlight = countInFlight(spoolDir, ['starting', 'running']);
    for (const id of listRequestIds(spoolDir)) {
      if (readStatus(spoolDir, id)) continue;
      const request = readRequest(spoolDir, id);
      if (!request) continue;
      if (parent.role === 'child') {
        this.end(id, 'rejected', DEPTH_LIMIT_MESSAGE);
        const record = readRecord(spoolDir, id);
        if (record) this.settle(record);
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
        this.end(
          id,
          'failed',
          `did not become ready in time (no container after ${this.opts.readiness.attempts} polls)`
        );
      }
    }
    this.takeSignals();
  }

  /**
   * The parent's cancels (ADR-0015): a request not yet started is canceled
   * on the spot; one in flight is asked to stop and marked when it exits.
   * A cancel for a settled request has nothing left to do.
   */
  private takeCancels(): void {
    for (const id of listRequestIds(this.opts.spoolDir)) {
      if (!takeCancelSignal(this.opts.spoolDir, id)) continue;
      const status = readStatus(this.opts.spoolDir, id)?.status;
      if (status === undefined) {
        log.info(`Sibling ${id}: canceled before it was started`);
        this.end(id, 'canceled', `${CANCELED_MESSAGE} before it was started`);
        const record = readRecord(this.opts.spoolDir, id);
        if (record) this.settle(record);
        continue;
      }
      const flight = this.inFlight.get(id);
      if (!flight) continue;
      log.info(`Sibling ${id}: cancel received, stopping it`);
      this.canceling.add(id);
      flight.child.kill();
    }
  }

  /** The parent said "cleared" or "resolved" for a waiting merge-back: retry it. */
  private takeSignals(): void {
    for (const outcome of this.outcomes) {
      // Every signal is consumed: one written for a merge that has moved on
      // since (landed behind another) has nothing to do and must not linger.
      if (!takeMergeSignal(this.opts.spoolDir, outcome.id)) continue;
      if (!MERGE_SIGNAL_STATES.includes(outcome.merge.status)) continue;
      log.info(`Sibling ${outcome.id}: merge signal received, retrying`);
      this.retry(outcome.id);
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
        spoolDir,
      });
    } catch (err) {
      this.end(
        request.id,
        'failed',
        `could not start the sibling process: ${errorMessage(err)}`
      );
      return;
    }
    this.inFlight.set(request.id, { child, polls: 0, logFile });
    child.exited.then(
      code => this.onExit(request.id, code, logFile),
      err => this.onExit(request.id, 1, logFile, errorMessage(err))
    );
  }

  /**
   * The sibling reports its own result; a process that never did has failed;
   * one the parent canceled is `canceled` whatever it reported. Either way
   * its record is settled: merged back or skipped, and reported.
   */
  private onExit(
    id: string,
    code: number,
    logFile: string,
    reason?: string
  ): void {
    this.inFlight.delete(id);
    const previous = readStatus(this.opts.spoolDir, id);
    if (this.canceling.delete(id)) {
      writeStatus(this.opts.spoolDir, id, {
        ...previous,
        status: 'canceled',
        error: CANCELED_MESSAGE,
        exitCode: previous?.exitCode ?? code,
        updatedAt: this.now(),
      });
    } else if (previous?.status !== 'done' && previous?.status !== 'failed') {
      const tail = logTail(logFile);
      this.end(
        id,
        'failed',
        reason ??
          `sibling process exited with code ${code} before reporting a result${tail ? `: ${tail}` : ''}`,
        code
      );
    }
    const record = readRecord(this.opts.spoolDir, id);
    if (record) this.settle(record);
  }

  /** Folds a finished sibling in (or explains why not) and publishes the outcome. */
  private settle(record: SiblingRecord): void {
    const merge = this.mergeFor(record);
    this.publish(record, merge);
    if (mergeLanded(merge)) this.drainHeld();
  }

  /** The merge-back a finished record gets: attempted only for a `done` sibling that exited 0. */
  private mergeFor(record: SiblingRecord): MergeBack {
    switch (record.status) {
      case 'failed':
        return {
          status: 'skipped',
          reason: `the sibling failed: ${record.error ?? 'no reason reported'}`,
        };
      case 'canceled':
        return {
          status: 'skipped',
          reason: `the sibling was canceled: ${record.error ?? CANCELED_MESSAGE}`,
        };
      case 'rejected':
        return {
          status: 'skipped',
          reason: `the request was rejected: ${record.error ?? 'no reason reported'}`,
        };
      default:
        break;
    }
    if (record.answer !== undefined) {
      return {
        status: 'skipped',
        reason:
          'a remote A2A agent has no branch to merge; its answer is in the report',
      };
    }
    if (!record.branch) {
      return { status: 'skipped', reason: 'the sibling never got a branch' };
    }
    if (record.exitCode !== undefined && record.exitCode !== 0) {
      return {
        status: 'skipped',
        reason: `the sibling exited with code ${record.exitCode}; its uncommitted work was not captured`,
      };
    }
    return mergeBackSibling(this.opts.git, this.opts.parent, {
      id: record.id,
      branch: record.branch,
    });
  }

  /** One more attempt at a waiting merge-back: a held one from the top, a conflict concluded. */
  private retry(id: string): void {
    if (this.attempt(id)) this.drainHeld();
  }

  /**
   * One more attempt at a waiting merge-back: a held one from the top, a
   * conflict concluded. True when the sibling's work landed this time.
   */
  private attempt(id: string): boolean {
    const previous = this.settled.get(id);
    const record = readRecord(this.opts.spoolDir, id);
    if (!previous?.branch || !record) return false;
    const sibling = { id, branch: previous.branch };
    const merge =
      previous.merge.status === 'conflict'
        ? concludeMergeBack(
            this.opts.git,
            this.opts.parent,
            sibling,
            previous.merge
          )
        : mergeBackSibling(this.opts.git, this.opts.parent, sibling);
    this.publish(record, merge);
    return mergeLanded(merge);
  }

  /**
   * A merge landed, so whatever was held behind it (a merge in progress, a
   * refusal) may go now: retry the held ones, and again while any lands.
   */
  private drainHeld(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const outcome of this.outcomes) {
        if (outcome.merge.status !== 'held') continue;
        if (this.attempt(outcome.id)) progressed = true;
      }
    }
  }

  /** Records a sibling's outcome where the parent reads it: the status, the report, this consumer. */
  private publish(record: SiblingRecord, merge: MergeBack): void {
    const { spoolDir, parent } = this.opts;
    let report: string | undefined;
    try {
      report = writeSiblingReport(parent.worktreePath, record, merge);
    } catch (err) {
      log.warn(
        `Sibling ${record.id}: could not write its report into ${parent.worktreePath}: ${errorMessage(err)}`
      );
    }
    const status: SettledState =
      record.status === 'failed' ||
      record.status === 'canceled' ||
      record.status === 'rejected'
        ? record.status
        : 'done';
    const outcome: SiblingOutcome = {
      id: record.id,
      agent: record.agent,
      ...(record.branch !== undefined ? { branch: record.branch } : {}),
      status,
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
      merge,
      ...(report !== undefined ? { report } : {}),
    };
    writeStatus(spoolDir, record.id, {
      status: outcome.status,
      ...(outcome.branch !== undefined ? { branch: outcome.branch } : {}),
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ...(record.answer !== undefined ? { answer: record.answer } : {}),
      merge,
      ...(report !== undefined ? { report } : {}),
      updatedAt: this.now(),
    });
    this.settled.set(record.id, outcome);
    const detail = [
      ...(merge.files?.length ? [merge.files.join(', ')] : []),
      ...(merge.reason ? [merge.reason] : []),
    ].join('; ');
    log.info(
      `Sibling ${record.id}: merge-back ${merge.status}${detail ? ` (${detail})` : ''}`
    );
  }

  /** Ends a request the host gives up on: `failed`, `canceled` or `rejected`, with the reason. */
  private end(
    id: string,
    status: Exclude<SettledState, 'done'>,
    error: string,
    exitCode?: number
  ): void {
    log.warn(`Sibling ${id}: ${status}, ${error}`);
    writeStatus(this.opts.spoolDir, id, {
      status,
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
