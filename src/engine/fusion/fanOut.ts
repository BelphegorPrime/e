/**
 * **The fan-out of a Fusion run** (ADR-0019 sections 3, 4 and 9): one task to
 * every candidate Agent of a profile, each an ordinary `e spawn` child - its
 * own worktree, branch and container - cut from one base pinned before the
 * first launch, and each collected into the fusion record whatever became
 * of it.
 *
 * The coordinator sits above the run machinery rather than inside it: a
 * candidate is launched through `childRun.ts`, like a Sibling run or an A2A
 * task, and told what makes it a candidate by host-set markers (the pinned
 * base, the fusion's spool; it pushes nothing and opens no PR), so no
 * harness, adapter or provider knows it is part of a fusion.
 *
 * - **At most `maxConcurrency` alive**, launched in profile order as slots
 *   free, and **one image build at a time**: the next candidate starts only
 *   once every earlier one has built and cut its worktree (`starting`), so N
 *   candidates never race one build, and a later candidate of an Agent whose
 *   image is fresh passes `--no-rebuild`.
 * - **A failure discards nothing**: a candidate that fails, is empty or
 *   cannot even launch gets its envelope, and the others go on.
 * - **The close pushes every usable branch**, after the last candidate has
 *   stopped, so no candidate can read a rival off the remote mid-run.
 * - **A cancel** kills every candidate alive, launches none of the rest, and
 *   pushes nothing; each still gets its envelope.
 * - **Two deadlines** (ADR-0019 section 9), declared or derived from the
 *   Store's `loop`: at `candidatesMs` every outstanding candidate is stopped
 *   as `timed-out` and the fan-out closes as usual; at `totalMs` everything
 *   outstanding is stopped, nothing is pushed, and the fusion is `exhausted`.
 * - **Retries** are new candidate runs, off unless the profile declares
 *   them: a failed attempt the classifier calls retryable gets a fresh
 *   `cand-NNN` after a backoff with jitter, never past `candidatesMs`, and
 *   its first envelope stays.
 * - **A host-wide bound**, when `config.json` sets `fusion.hostConcurrency`:
 *   a candidate also needs one of the host's slots, shared with every other
 *   `e fuse` on this host, and waits for one - the wait counts against
 *   `candidatesMs` like any other.
 * - **A hard wall clock**: a candidate the fusion stopped that has not exited
 *   once {@link FUSION_KILL_GRACE_MS} is spent is killed outright, so no
 *   teardown that hangs holds the fusion past its deadline by more than that.
 */

import fs from 'node:fs';
import path from 'node:path';
import { monotonicFactory } from 'ulid';
import type { HarnessAgent } from '../../core/agent/agent.js';
import {
  classifyAttempt,
  fusionDeadlines,
  retryDelayMs,
  retryPolicy,
  type RetryClassifier,
} from '../../core/fusion/budget.js';
import type { FoundFusionProfile } from '../../core/fusion/load.js';
import {
  isUsable,
  type CandidateEnd,
  type CandidateResult,
} from '../../core/fusion/result.js';
import { HARNESSES } from '../../core/harness/index.js';
import { DEFAULT_LOOP_CAPS, type LoopCaps } from '../../core/store/config.js';
import type { Git } from '../../ports/git/index.js';
import {
  ensureSpool,
  nextRequestId,
  readStatus,
  writeRequest,
} from '../../sidecars/broker/contract/spool.js';
import type { SpawnRequest } from '../../sidecars/broker/contract/types.js';
import { SPAWN_FLAGS } from '../../shared/spawnArgs.js';
import { env } from '../../shared/utils/env.js';
import { errorMessage } from '../../shared/utils/errors.js';
import { log } from '../../shared/utils/log.js';
import {
  settleChildRun,
  startChildRun,
  type ChildHandle,
  type ChildLauncher,
} from '../runs/childRun.js';
import { CANCEL_GRACE_MS, type RunBase } from '../runs/runSpawn.js';
import { Waker, realSleep, type Sleep } from './clock.js';
import { collectCandidateResult, type SettledCandidate } from './collect.js';
import type { HostSlotLease, HostSlots } from './hostSlots.js';
import {
  pruneFusions,
  reconcileFusions,
  writeFusionRecord,
  type FusionAgentSnapshot,
  type FusionDeadlineRecord,
  type FusionRecord,
  type FusionState,
} from './record.js';

/** Where the children's spools live under the worktrees dir: `.fusion/<fusion id>`. */
const FUSION_SPOOLS_DIR = '.fusion';

/** Who stops a candidate, as its status says (`canceled by the fusion`). */
const FUSION_ACTOR = 'the fusion';

/** The reason of a fusion, and of each candidate, that `totalMs` stopped (ADR-0019 section 8). */
export const FUSION_TIMEOUT_REASON = 'exhausted:fusion-timeout';

/** The exit code of a candidate whose `e spawn` could not even start, as `settleChildRun` records it. */
const LAUNCH_FAILED_EXIT_CODE = 1;

/**
 * How long a live candidate holds the next launch back while it builds.
 * Builds are one at a time so they never race; past this, a hung build no
 * longer holds every other candidate back (its own caps are #178's).
 */
export const DEFAULT_BUILD_GATE_MS = 20 * 60 * 1000;

/**
 * How long a child the fusion stopped may take to exit before it is killed
 * outright (SIGKILL): past its own {@link CANCEL_GRACE_MS}, so a child that
 * tears down in time is never cut short. A fusion therefore ends at most this
 * long after a deadline or a cancel.
 */
export const FUSION_KILL_GRACE_MS = CANCEL_GRACE_MS + 30_000;

const newUlid = monotonicFactory();

/** What a fan-out runs on. */
export interface FanOutDeps {
  /** The checkout's repository: the base is pinned here and the branches pushed from here. */
  git: Git;
  /** The checkout's `.e/`: the fusion record lives in it. */
  storeDir: string;
  /** Where the children's spool goes, beside the run worktrees. */
  worktreesDir: string;
  /** Starts one candidate; defaults to re-invoking this CLI. Tests script one. */
  launch?: ChildLauncher;
  /** `e spawn` arguments every candidate inherits (`--dir`, `--env-file`, `--runtime`). */
  passthroughArgs?: readonly string[];
  /** The environment the candidates' is derived from; `process.env` by default. */
  baseEnv?: Record<string, string | undefined>;
  /** Keep the spool and the children's logs when the fusion ends here (`--keep-worktree`). */
  keepSpool?: boolean;
  /** How often the children are checked on; an exit or a cancel wakes the loop at once. */
  pollIntervalMs?: number;
  /** See {@link DEFAULT_BUILD_GATE_MS}. */
  buildGateMs?: number;
  now?: () => Date;
  /**
   * The loop's wait, between polls and until a backoff or a deadline is
   * over; a timer by default. Tests advance an injected clock instead.
   */
  sleep?: Sleep;
  /** The jitter source of a retry's backoff; `Math.random` by default. */
  random?: () => number;
  /**
   * The Store's `loop` caps (`config.json`), which the undeclared deadlines
   * are derived from (ADR-0019 section 9); {@link DEFAULT_LOOP_CAPS} when
   * absent.
   */
  loop?: Pick<LoopCaps, 'totalTimeoutMs'>;
  /** Which failed attempts are retried; `classifyAttempt` by default. */
  classifyAttempt?: RetryClassifier;
  /**
   * The host-wide bound (`fusion.hostConcurrency`), shared with every other
   * coordinator on this host; absent, only `maxConcurrency` bounds.
   */
  hostSlots?: HostSlots;
  /** See {@link FUSION_KILL_GRACE_MS}. */
  killGraceMs?: number;
  newFusionId?: () => string;
  /** Whether a recorded coordinator is still running; for reconciling old records. */
  isAlive?: (pid: number) => boolean;
}

/** What one fan-out is asked. */
export interface FanOutParams {
  /** The profile, its Agents resolved (`findFusionProfile`). */
  found: FoundFusionProfile;
  /** The task, as every candidate gets it. */
  prompt: string;
  /** A cancel: Ctrl-C, SIGTERM, or a caller giving up. */
  abort?: AbortSignal;
  /** Progress, for the CLI to render. */
  onEvent?: (event: FanOutEvent) => void;
}

/**
 * A fusion deadline that fired (ADR-0019 section 9's accounting seam):
 * which budget, its length, and the candidate attempts it stopped - alive or
 * never started.
 */
export interface BudgetExhaustedEvent {
  kind: 'budget-exhausted';
  budget: 'candidatesMs' | 'totalMs';
  limitMs: number;
  stopped: string[];
}

/**
 * What the fan-out reports as it goes: one event per candidate start
 * (`launched`), end (`settled`), retry decision and budget exhaustion - the
 * accounting seam of ADR-0019 section 9, which a later control plane can
 * consume without a store of its own.
 */
export type FanOutEvent =
  /**
   * The base is pinned and the record written, before the first launch:
   * every candidate attempt as it is queued, in launch order.
   */
  | {
      kind: 'prepared';
      fusion: string;
      base: RunBase;
      candidates: { candidate: string; agent: string }[];
    }
  | {
      kind: 'launched';
      candidate: string;
      agent: string;
      /** The fusion-level attempt, 1 for the first. */
      attempt: number;
      /** The attempt this one retries. */
      retryOf?: string;
    }
  | { kind: 'settled'; candidate: string; result: CandidateResult }
  | {
      /**
       * The candidate is next, but every host slot is held (`limit`, across
       * every `e fuse` on this host): it waits for one. Once per attempt.
       */
      kind: 'host-slot-wait';
      candidate: string;
      agent: string;
      limit: number;
    }
  | {
      /** A failed attempt gets another: a new record, launched once `notBefore` has passed. */
      kind: 'retry-scheduled';
      candidate: string;
      agent: string;
      attempt: number;
      retryOf: string;
      delayMs: number;
      notBefore: string;
    }
  | {
      /**
       * A retryable attempt that gets no other, because the profile's
       * `retry.maxAttempts` is spent or the backoff would end past
       * `candidatesMs`. Only reported when the profile declares retries.
       */
      kind: 'retry-skipped';
      candidate: string;
      agent: string;
      attempt: number;
      why: 'max-attempts' | 'candidates-deadline';
    }
  | BudgetExhaustedEvent
  | {
      kind: 'closed';
      usable: number;
      pushed: string[];
      pushWarnings: string[];
    };

/** How the fan-out ended. */
export interface FanOutResult {
  fusion: string;
  base: RunBase;
  /**
   * `fanning-out` when the fan-out closed and the synthesis may start - the
   * Fusion run is still live, and its record says so; `failed`, `canceled`
   * or `exhausted` (its `totalMs` passed, exit code 2) when it ended here.
   */
  state: FusionState;
  reason?: string;
  /** Every candidate attempt, retries included, in the order they were created. */
  candidates: CandidateResult[];
  /** The ones with commits beyond the base, whatever their verdict. */
  usable: CandidateResult[];
  /** The usable branches pushed when the fan-out closed. */
  pushed: string[];
  pushWarnings: string[];
  /** The children's spool, with their logs: removed when the fusion ends. */
  spoolDir: string;
  /** The deadlines the fusion runs with; the synthesis honours `totalAt`. */
  deadlines?: FusionDeadlineRecord;
}

/** How the fusion itself stopped an attempt, and what its envelope then says. */
interface Stop {
  by: NonNullable<CandidateEnd['stoppedBy']>;
  /** Who, for the status: `canceled by <actor>`. */
  actor: string;
  /** A fusion reason that outranks the run's own. */
  reason?: string;
}

/** One candidate attempt the fan-out is driving. */
interface Slot {
  request: SpawnRequest;
  agent: HarnessAgent;
  /** The fusion-level attempt, 1 for the first. */
  attempt: number;
  /** The record id of the attempt this one retries. */
  retryOf?: string;
  /** A retry is not launched before this moment (epoch ms): its backoff. */
  notBefore?: number;
  /** True once a launch was attempted, whether or not the process started. */
  launched?: boolean;
  handle?: ChildHandle;
  startedAt?: Date;
  /** The code the process exited with, once it has. */
  code?: number;
  /** Set when the fusion stopped it. */
  stop?: Stop;
  /** When the fusion's SIGTERM went out (epoch ms); SIGKILL follows past the grace. */
  stoppedAt?: number;
  /** True once the grace was spent and SIGKILL sent. */
  forced?: boolean;
  /** The host slot it holds, from its launch until it is collected. */
  lease?: HostSlotLease;
  /** True once its wait for a host slot was reported. */
  waitReported?: boolean;
}

/**
 * Runs the fan-out of one Fusion run and returns every candidate's result.
 * Throws only before anything has started: no repository, a detached HEAD,
 * an empty prompt.
 */
export async function runFanOut(
  deps: FanOutDeps,
  params: FanOutParams
): Promise<FanOutResult> {
  const now = deps.now ?? (() => new Date());
  const { profile, agents } = params.found;
  const prompt = params.prompt.trim();
  if (prompt === '') {
    throw new Error(`Fusion "${profile.name}" needs a prompt.`);
  }

  // The base, pinned once: a `git pull` while a candidate waits for a slot
  // must not give it a different start (ADR-0019 section 4).
  const sha = deps.git.headSha();
  const branch = deps.git.currentBranch();
  if (branch === '') {
    throw new Error(
      'A fusion proposes its result into the branch it started from, and this checkout is on a detached HEAD; check out a branch first.'
    );
  }
  const base: RunBase = { sha, ref: `refs/heads/${branch}`, branch };

  // Before this fusion's record exists: what a dead coordinator left is
  // interrupted, and what ended long ago is pruned.
  reconcileFusions(deps.storeDir, { isAlive: deps.isAlive, now: now() });
  pruneFusions(deps.storeDir, now());

  const fusion = deps.newFusionId?.() ?? `fusion-${newUlid()}`;
  const spoolDir = fusionSpoolDir(deps.worktreesDir, fusion);
  ensureSpool(spoolDir);
  /** A new attempt's request, its id the next `cand-NNN`: never one used before. */
  const request = (agentName: string): SpawnRequest => {
    const next: SpawnRequest = {
      id: nextRequestId(spoolDir, 'cand'),
      agent: agentName,
      prompt,
      requestedAt: now().toISOString(),
    };
    writeRequest(spoolDir, next);
    return next;
  };
  /** Every attempt, in the order they were created: the profile's, then the retries. */
  const slots: Slot[] = profile.candidates.map(name => ({
    request: request(name),
    agent: agents.get(name)!,
    attempt: 1,
  }));

  // The deadlines count from here, the fusion's start (ADR-0019 section 9).
  const started = now();
  const limits = fusionDeadlines(profile, deps.loop ?? DEFAULT_LOOP_CAPS);
  const candidatesAt = started.getTime() + limits.candidatesMs;
  const totalAt = started.getTime() + limits.totalMs;
  const deadlines: FusionDeadlineRecord = {
    ...limits,
    candidatesAt: new Date(candidatesAt).toISOString(),
    totalAt: new Date(totalAt).toISOString(),
  };
  const retry = retryPolicy(profile);
  const classify = deps.classifyAttempt ?? classifyAttempt;
  const random = deps.random ?? Math.random;

  const createdAt = started.toISOString();
  let record: FusionRecord = {
    schemaVersion: 1,
    fusion,
    state: 'prepared',
    profile,
    agents: snapshot(agents),
    prompt,
    base,
    candidates: slots.map(slot => slot.request.id),
    deadlines,
    coordinator: { pid: process.pid },
    createdAt,
    updatedAt: createdAt,
  };
  const save = (patch: Partial<FusionRecord>): void => {
    record = { ...record, ...patch, updatedAt: now().toISOString() };
    writeFusionRecord(deps.storeDir, record);
  };
  save({});
  params.onEvent?.({
    kind: 'prepared',
    fusion,
    base,
    candidates: slots.map(slot => ({
      candidate: slot.request.id,
      agent: slot.agent.name,
    })),
  });

  const results = new Map<string, CandidateResult>();
  const collect = (slot: Slot): CandidateResult => {
    // Its host slot goes back as soon as it has ended, whatever became of it.
    slot.lease?.release();
    const status = readStatus(spoolDir, slot.request.id);
    const ended = now();
    const reason = slot.stop?.reason ?? status?.reason;
    const settled: SettledCandidate = {
      fusion,
      candidate: slot.request.id,
      agent: slot.agent,
      harnessVersion: harnessVersionOf(slot.agent),
      base: { sha, branch },
      ...(status?.branch !== undefined ? { branch: status.branch } : {}),
      // A candidate that never launched has no exit code to report.
      ...(slot.launched
        ? { exitCode: status?.exitCode ?? slot.code ?? LAUNCH_FAILED_EXIT_CODE }
        : {}),
      ...(slot.stop ? { stoppedBy: slot.stop.by } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(status?.verify !== undefined ? { verify: status.verify } : {}),
      attempt: slot.attempt,
      ...(slot.retryOf !== undefined ? { retryOf: slot.retryOf } : {}),
      startedAt: slot.startedAt ?? ended,
      endedAt: ended,
    };
    let result: CandidateResult;
    try {
      result = collectCandidateResult(deps.git, deps.storeDir, settled);
    } catch (err) {
      // One unreadable branch costs the fusion that candidate, not the rest.
      log.warn(
        `Could not collect ${slot.request.id} (${slot.agent.name}): ${errorMessage(err)}`
      );
      result = collectCandidateResult(deps.git, deps.storeDir, {
        ...settled,
        unreadable: true,
      });
    }
    results.set(slot.request.id, result);
    params.onEvent?.({ kind: 'settled', candidate: slot.request.id, result });
    return result;
  };

  const pending = [...slots];
  const alive: Slot[] = [];
  /** Agents whose image a candidate has already built in this fan-out. */
  const built = new Set<string>();
  /** Set once a cancel or a deadline has stopped the fan-out: nothing more starts. */
  let stopping: 'cancel' | 'candidates' | 'total' | undefined;
  /** A human cancel was seen, before or after a deadline: the fusion is canceled. */
  let canceled = false;
  const waker = new Waker(deps.sleep ?? realSleep);

  /**
   * The one place a failed attempt gets another (ADR-0019 section 9): only
   * when the classifier calls it retryable, the profile's attempts are not
   * spent, and the backoff ends before `candidatesMs` - a retry never
   * extends the fan-out.
   */
  const maybeRetry = (slot: Slot, result: CandidateResult): void => {
    if (stopping || slot.stop || classify(result) !== 'retryable') return;
    const skip = (why: 'max-attempts' | 'candidates-deadline'): void => {
      // With retries off, a failure is just a failure: nothing to report.
      if (retry.maxAttempts <= 1) return;
      params.onEvent?.({
        kind: 'retry-skipped',
        candidate: slot.request.id,
        agent: slot.agent.name,
        attempt: slot.attempt,
        why,
      });
    };
    if (slot.attempt >= retry.maxAttempts) {
      skip('max-attempts');
      return;
    }
    const delayMs = retryDelayMs(retry, slot.attempt, random);
    const notBefore = now().getTime() + delayMs;
    if (notBefore >= candidatesAt || notBefore >= totalAt) {
      skip('candidates-deadline');
      return;
    }
    const next: Slot = {
      request: request(slot.request.agent),
      agent: slot.agent,
      attempt: slot.attempt + 1,
      retryOf: slot.request.id,
      notBefore,
    };
    slots.push(next);
    pending.push(next);
    save({ candidates: slots.map(s => s.request.id) });
    params.onEvent?.({
      kind: 'retry-scheduled',
      candidate: next.request.id,
      agent: next.agent.name,
      attempt: next.attempt,
      retryOf: slot.request.id,
      delayMs,
      notBefore: new Date(notBefore).toISOString(),
    });
  };

  const launch = (slot: Slot): void => {
    const reuse = built.has(slot.agent.name);
    slot.startedAt = now();
    slot.launched = true;
    let handle: ChildHandle;
    try {
      handle = startChildRun({
        spoolDir,
        request: slot.request,
        env: env.withFusionCandidate(
          { spoolDir, id: slot.request.id },
          { fusion, base },
          deps.baseEnv ?? process.env
        ),
        passthroughArgs: [
          ...(deps.passthroughArgs ?? []),
          ...(reuse ? [SPAWN_FLAGS.noRebuild] : []),
        ],
        ...(deps.launch ? { launch: deps.launch } : {}),
      });
    } catch (err) {
      settleChildRun({
        spoolDir,
        id: slot.request.id,
        code: LAUNCH_FAILED_EXIT_CODE,
        canceling: false,
        actor: FUSION_ACTOR,
        reason: `could not start the e spawn process: ${errorMessage(err)}`,
        now,
      });
      maybeRetry(slot, collect(slot));
      return;
    }
    slot.handle = handle;
    // The slot is in use while the child runs, even past this coordinator.
    if (handle.pid !== undefined) slot.lease?.attach(handle.pid);
    // The one reaction per child: record the code and wake the loop.
    void handle.exited.then(code => {
      slot.code = code;
      waker.wake();
    });
    alive.push(slot);
    params.onEvent?.({
      kind: 'launched',
      candidate: slot.request.id,
      agent: slot.agent.name,
      attempt: slot.attempt,
      ...(slot.retryOf !== undefined ? { retryOf: slot.retryOf } : {}),
    });
  };

  /**
   * Stops everything outstanding: every live attempt the fusion has not
   * stopped yet is killed, and what never started is collected as stopped.
   * A budget that fired says so first, naming what it stops, so a renderer
   * sees why before the settles it causes.
   */
  const stopAll = (
    stop: Stop,
    budget?: { budget: 'candidatesMs' | 'totalMs'; limitMs: number }
  ): void => {
    const live = alive.filter(slot => !slot.stop);
    const waiting = pending.splice(0);
    if (budget) {
      params.onEvent?.({
        kind: 'budget-exhausted',
        ...budget,
        stopped: [...live, ...waiting].map(slot => slot.request.id),
      });
    }
    for (const slot of live) {
      slot.stop = stop;
      slot.stoppedAt = now().getTime();
      slot.handle!.kill();
    }
    for (const slot of waiting) {
      slot.stop = stop;
      collect(slot);
    }
  };

  /**
   * A host slot for `slot`, when the host is bounded; false, reported once,
   * when every one is held.
   */
  const acquireHostSlot = (slot: Slot): boolean => {
    if (!deps.hostSlots) return true;
    const lease = deps.hostSlots.tryAcquire({
      fusion,
      candidate: slot.request.id,
    });
    if (lease) {
      slot.lease = lease;
      return true;
    }
    if (!slot.waitReported) {
      slot.waitReported = true;
      params.onEvent?.({
        kind: 'host-slot-wait',
        candidate: slot.request.id,
        agent: slot.agent.name,
        limit: deps.hostSlots.limit,
      });
    }
    return false;
  };

  const pollMs = deps.pollIntervalMs ?? 1000;
  const gateMs = deps.buildGateMs ?? DEFAULT_BUILD_GATE_MS;
  const killGraceMs = deps.killGraceMs ?? FUSION_KILL_GRACE_MS;
  /** Set while a ready candidate waits for a host slot: the loop polls for one. */
  let hostBlocked = false;
  /**
   * How long the loop may sleep: a poll while anything is alive, and never
   * past the next moment something is due - a deadline that has not fired,
   * the end of a retry's backoff, the end of a stopped child's grace.
   */
  const nextWait = (): number => {
    const t = now().getTime();
    let wait =
      alive.length > 0 || hostBlocked ? pollMs : Number.POSITIVE_INFINITY;
    for (const slot of alive) {
      if (slot.stoppedAt !== undefined && !slot.forced) {
        wait = Math.min(wait, slot.stoppedAt + killGraceMs - t);
      }
    }
    if (!canceled && stopping !== 'total') wait = Math.min(wait, totalAt - t);
    if (stopping === undefined) wait = Math.min(wait, candidatesAt - t);
    for (const slot of pending) {
      if (slot.notBefore !== undefined && slot.notBefore > t) {
        wait = Math.min(wait, slot.notBefore - t);
      }
    }
    return Math.max(0, wait);
  };
  const onAbort = (): void => waker.wake();
  params.abort?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      // Settle whatever has exited first, so a candidate that finished just
      // before a cancel or a deadline is recorded as finished, not stopped.
      for (const slot of [...alive]) {
        if (slot.code === undefined) continue;
        alive.splice(alive.indexOf(slot), 1);
        settleChildRun({
          spoolDir,
          id: slot.request.id,
          code: slot.code,
          canceling: slot.stop !== undefined,
          actor: slot.stop?.actor ?? FUSION_ACTOR,
          now,
        });
        maybeRetry(slot, collect(slot));
      }
      const t = now().getTime();
      // A stopped child that is still there past its grace is killed
      // outright: the fusion's deadlines are hard (ADR-0019 section 9).
      for (const slot of alive) {
        if (slot.stoppedAt === undefined || slot.forced) continue;
        if (t - slot.stoppedAt < killGraceMs) continue;
        slot.forced = true;
        log.warn(
          `${slot.request.id} (${slot.agent.name}) did not stop within ${killGraceMs} ms; killing it outright.`
        );
        slot.handle!.kill('SIGKILL');
      }
      // A cancel outranks a deadline, and the whole outranks the fan-out.
      if (params.abort?.aborted && !canceled) {
        canceled = true;
        stopping = 'cancel';
        stopAll({ by: 'cancel', actor: FUSION_ACTOR });
      } else if (!canceled && stopping !== 'total' && t >= totalAt) {
        stopping = 'total';
        stopAll(
          {
            by: 'cancel',
            actor: `${FUSION_ACTOR}'s totalMs`,
            reason: FUSION_TIMEOUT_REASON,
          },
          { budget: 'totalMs', limitMs: limits.totalMs }
        );
      } else if (stopping === undefined && t >= candidatesAt) {
        stopping = 'candidates';
        stopAll(
          {
            by: 'candidates-deadline',
            actor: `${FUSION_ACTOR}'s candidatesMs`,
          },
          { budget: 'candidatesMs', limitMs: limits.candidatesMs }
        );
      }
      // A candidate has built its images once it reports its branch: that is
      // `starting`, after the builds and the worktree (ADR-0005).
      let building = false;
      for (const slot of alive) {
        if (readStatus(spoolDir, slot.request.id)?.branch !== undefined) {
          built.add(slot.agent.name);
        } else if (now().getTime() - slot.startedAt!.getTime() < gateMs) {
          building = true;
        }
      }
      // One build at a time: nothing else starts while a live candidate is
      // still building - unless it has been at it past the gate, so one hung
      // build cannot hold every other candidate back forever. A retry waits
      // out its backoff without holding back the candidates behind it.
      // A candidate that is next but finds every host slot held waits for
      // one, and holds back the ones behind it: the order stays the profile's.
      hostBlocked = false;
      while (!stopping && !building && alive.length < profile.maxConcurrency) {
        const at = now().getTime();
        const ready = pending.findIndex(slot => (slot.notBefore ?? 0) <= at);
        if (ready < 0) break;
        if (!acquireHostSlot(pending[ready])) {
          hostBlocked = true;
          break;
        }
        const [slot] = pending.splice(ready, 1);
        launch(slot);
        if (slot.handle) building = true;
      }
      if (alive.length === 0 && pending.length === 0) break;
      await waker.sleep(nextWait());
    }
  } catch (err) {
    // Whatever broke the loop, no candidate outlives it and the record says
    // so; the spool stays, with the logs, for whoever looks next.
    for (const slot of alive) slot.handle?.kill();
    save({
      state: 'failed',
      reason: 'aborted:fusion-coordinator',
      endedAt: now().toISOString(),
    });
    throw err;
  } finally {
    params.abort?.removeEventListener('abort', onAbort);
    // No lease outlives the fan-out, except a child's the loop broke away
    // from: that one names the child, and is free once the child is gone.
    for (const slot of slots) {
      if (!alive.includes(slot)) slot.lease?.release();
    }
  }

  // The fan-out is closed: every candidate has stopped.
  const candidates = slots.map(slot => results.get(slot.request.id)!);
  const usable = candidates.filter(isUsable);
  const pushed: string[] = [];
  const pushWarnings: string[] = [];
  let state: FusionState = 'fanning-out';
  let reason: string | undefined;
  if (canceled) {
    // A canceled fusion pushes nothing, as a canceled run does not (ADR-0015).
    state = 'canceled';
  } else if (stopping === 'total') {
    // The whole fusion's deadline: no synthesis, no PR, and the fan-out
    // never closed, so its branches stay local (ADR-0019 section 9).
    state = 'exhausted';
    reason = FUSION_TIMEOUT_REASON;
  } else {
    for (const branchName of new Set(usable.map(result => result.branch!))) {
      try {
        deps.git.push(branchName);
        pushed.push(branchName);
      } catch (err) {
        pushWarnings.push(`could not push ${branchName}: ${errorMessage(err)}`);
      }
    }
    if (usable.length < profile.minUsable) {
      state = 'failed';
      reason = 'aborted:no-usable-candidate';
    }
  }
  params.onEvent?.({
    kind: 'closed',
    usable: usable.length,
    pushed,
    pushWarnings,
  });
  const closedAt = now().toISOString();
  save({
    state,
    ...(reason !== undefined ? { reason } : {}),
    fanOut: { closedAt, usable: usable.length, pushed, pushWarnings },
    ...(state === 'fanning-out' ? {} : { endedAt: closedAt }),
  });
  // The logs go when the fusion ends; a fusion that goes on to its synthesis
  // leaves them for the step that ends it (`removeFusionSpool`).
  if (state !== 'fanning-out' && !deps.keepSpool) {
    removeFusionSpool(deps.worktreesDir, fusion);
  }

  return {
    fusion,
    base,
    state,
    ...(reason !== undefined ? { reason } : {}),
    candidates,
    usable,
    pushed,
    pushWarnings,
    spoolDir,
    deadlines,
  };
}

/** The spool of a Fusion run's children, beside the run worktrees. */
export function fusionSpoolDir(worktreesDir: string, fusion: string): string {
  return path.join(worktreesDir, FUSION_SPOOLS_DIR, fusion);
}

/** Removes a Fusion run's spool and its children's logs: a log holds tool output, and tool output holds secrets. */
export function removeFusionSpool(worktreesDir: string, fusion: string): void {
  fs.rmSync(fusionSpoolDir(worktreesDir, fusion), {
    recursive: true,
    force: true,
  });
}

/** The pinned version of an Agent's harness, as the envelope and the record carry it. */
function harnessVersionOf(agent: HarnessAgent): string {
  return HARNESSES[agent.harness]?.version ?? 'unknown';
}

/** The resolved Agents as the record keeps them: identities, never a key or an endpoint. */
function snapshot(
  agents: ReadonlyMap<string, HarnessAgent>
): FusionAgentSnapshot[] {
  return [...agents.values()].map(agent => ({
    name: agent.name,
    harness: agent.harness,
    harnessVersion: harnessVersionOf(agent),
    provider: agent.provider
      ? { protocol: agent.provider.protocol, model: agent.provider.model }
      : null,
    skills: [...(agent.skills ?? [])],
  }));
}
