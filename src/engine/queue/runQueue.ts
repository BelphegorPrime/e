/**
 * **The `serve` tick** (ADR-0016 section 6): the one consumer of the run
 * queue, and the one place a slot is counted.
 *
 * One interval of 30 s, in fixed order - reconcile (at start only), due
 * triggers, expire, sweep terminal, fill free slots - plus an immediate fill
 * on enqueue, so a triggered run does not wait an interval on an idle box.
 * Reconcile runs in `start`, before the first tick; that tick fires nothing,
 * since every next fire is computed from `now`, so on every tick that can
 * fire, due triggers are the first step, as ADR-0016 section 6 orders it. A claimed request
 * becomes an `e spawn` child (the ADR-0014 pattern) carrying `E_LEDGER_FILE`,
 * so the run reports into the very entry `serve` claimed, and `serve` itself
 * only launches a process and reads files (ADR-0010's BFF line).
 *
 * **A restart reconciles, never resumes.** Each non-terminal ledger entry is
 * checked against reality by container name, the thing actually holding
 * resources: gone means `interrupted`, the slot freed, the branch kept, no
 * retry; alive means left alone, slot held, not streamed - `serve` lost the
 * process, not the run. Re-entering an iteration after a crash would risk a
 * double commit. Known sharp edge, documented rather than repaired: during a
 * normal teardown the container is already gone too, so a restart inside
 * that window marks a healthy teardown `interrupted`.
 *
 * **Dead requests** are the ones that died before a run branch existed: TTL
 * expiry (a rename into `dead/`), overflow (a fresh write, since it never
 * entered `queue/`), a `base` that does not resolve at claim, and a run that
 * failed before it had a branch. Anything with a branch stays in the ledger.
 */

import { SPAWN_FLAGS } from '../../shared/spawnArgs.js';
import path from 'node:path';
import {
  DEFAULT_DEAD_CONFIG,
  type DeadConfig,
  type QueueConfig,
} from '../../core/store/config.js';
import type { RunBase } from '../runs/runSpawn.js';
import { isBaseError } from '../../core/trigger/oneShot.js';
import { env } from '../../shared/utils/env.js';
import { log } from '../../shared/utils/log.js';
import { errorMessage } from '../../shared/utils/errors.js';
import type { TriggerActivity } from '../../core/trigger/listing.js';
import {
  acceptEvent,
  provenanceStrings,
  webhookEventUrl,
} from '../../core/trigger/provenance.js';
import {
  childCliArgs,
  spawnChildProcess,
  type ChildHandle,
  type ChildLauncher,
} from '../runs/childRun.js';
import {
  buryLedgerEntry,
  claimRequest,
  enqueueRequest,
  ensureRunsDirs,
  expireQueue,
  isTerminalLedgerState,
  ledgerFile,
  listLedger,
  listQueue,
  newRequestId,
  requestUlid,
  patchLedgerFile,
  readLedgerEntry,
  sweepDead,
  sweepLedger,
  writeDeadRequest,
  type EnqueueResult,
  type DeathStage,
  type LedgerEntry,
  type RequestEvent,
  type RunRequest,
  type RunsDirs,
} from './runsSpool.js';

/**
 * The provenance markers a claimed request's `e spawn` receives: the queue
 * entry is the carrier, the child only reads it back. A request written
 * before acceptance recorded an event has none.
 */
function provenanceEnv(request: RunRequest): Record<string, string> {
  if (!request.event) return {};
  return env.provenanceEnv(
    provenanceStrings({
      trigger: request.trigger,
      event: request.event,
      ...(request.eventUrl !== undefined ? { url: request.eventUrl } : {}),
    })
  );
}

/** The tick interval: one timer, so a slot is counted in exactly one place. */
export const QUEUE_TICK_MS = 30 * 1000;

export interface RunQueueDeps {
  dirs: RunsDirs;
  config: QueueConfig;
  /** The bounds of `dead/`; the defaults when absent. */
  dead?: DeadConfig;
  /**
   * Resolves a claimed request's `base` (a rendered name, or none for the
   * repository's default branch) under the base rule, throwing a base error
   * when it does not resolve. Absent, a run cuts from wherever its `e spawn`
   * would by hand.
   */
  resolveBase?: (name: string | undefined, repo?: string) => RunBase;
  /**
   * The serving Store's root, which a request with a `repo` gets as `--dir`:
   * its child starts in the target repository, where no walk from the cwd
   * would find this Store (#201).
   */
  servingRoot?: string;
  /** True while a container of this name is running: what a restart checks entries against. */
  containerRunning(name: string): boolean;
  /** Starts a claimed request's `e spawn` child; defaults to re-invoking this CLI. */
  launch?: ChildLauncher;
  /** `e spawn` arguments every child inherits (`--dir`, `--env-file`). */
  passthroughArgs?: readonly string[];
  /**
   * The tick's first step: whatever fires on the clock enqueues here (the
   * cron scheduler), so a slot is still counted in one place only.
   */
  dueTriggers?: (now: Date) => void;
  now?: () => Date;
}

/**
 * What a caller hands {@link RunQueue.enqueue}: a request, less what the
 * queue assigns. The event is required - it is the run's provenance - and
 * arrives as the source spelled it: acceptance validates it.
 */
export type NewRunRequest = Omit<
  RunRequest,
  'id' | 'enqueuedAt' | 'event' | 'eventUrl'
> & { event: RequestEvent };

export class RunQueue {
  private readonly children = new Map<string, ChildHandle>();
  /** In memory since this queue started: after a restart it is unknown, not never. */
  private readonly activity = new Map<string, TriggerActivity>();
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => Date;
  /** Since when {@link triggerActivity} knows anything. */
  readonly startedAt: string;
  private readonly deadCaps: DeadConfig;

  constructor(private readonly deps: RunQueueDeps) {
    this.now = deps.now ?? (() => new Date());
    this.deadCaps = deps.dead ?? DEFAULT_DEAD_CONFIG;
    this.startedAt = this.now().toISOString();
    ensureRunsDirs(deps.dirs);
  }

  /** The trigger's last accepted request since {@link startedAt}, or undefined. */
  triggerActivity(trigger: string): TriggerActivity | undefined {
    return this.activity.get(trigger);
  }

  /** Reconciles the ledger once, runs a first tick, then ticks every {@link QUEUE_TICK_MS}. */
  start(): void {
    this.reconcile();
    this.tick();
    this.timer = setInterval(() => this.tick(), QUEUE_TICK_MS);
    this.timer.unref();
  }

  /** Stops ticking. Runs in flight keep going; their `e spawn` ends their entries. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Accepts a request - rejected when its key is pending or the queue is full,
   * and logged either way - and fills a free slot at once.
   *
   * **The acceptance boundary for provenance** (ADR-0016 section 9): the HMAC
   * signs the body, not the headers, so an event id off its pattern is
   * replaced by this request's own ULID here, before the file is written, and
   * the event page is derived from validated identifiers only. Everything
   * downstream - the child's environment, the commit trailers, the PR block -
   * takes the values as they are.
   */
  enqueue(request: NewRunRequest): EnqueueResult {
    const id = newRequestId('trg');
    const event = acceptEvent(request.event, requestUlid(id));
    const eventUrl = webhookEventUrl(event.source, request.payload);
    const full: RunRequest = {
      ...request,
      id,
      event,
      ...(eventUrl !== undefined ? { eventUrl } : {}),
      enqueuedAt: this.now().toISOString(),
    };
    const result = enqueueRequest(
      this.deps.dirs,
      full,
      this.deps.config.maxLength
    );
    switch (result.status) {
      case 'enqueued':
        log.info(`Queued ${full.id} (${full.key}) for ${full.agent}`);
        this.activity.set(full.trigger, {
          lastFiredAt: full.enqueuedAt,
          lastRequestId: full.id,
        });
        this.fill();
        break;
      case 'duplicate':
        log.info(`Not queued: ${full.key} is already pending`);
        break;
      case 'full': {
        // Rejected, never dropped-oldest: that would discard work already
        // accepted. The rejection is kept in dead/, which has caps of its own.
        const reason = `the queue is full (${this.deps.config.maxLength} waiting)`;
        log.warn(
          `Not queued: ${reason}; ${full.key} is a dead request (${full.id})`
        );
        writeDeadRequest(this.deps.dirs, {
          request: full,
          stage: 'overflow',
          reason,
          diedAt: full.enqueuedAt,
        });
        sweepDead(this.deps.dirs, this.now(), this.deadCaps);
        break;
      }
    }
    return result;
  }

  /**
   * One pass after start: due triggers, expire into dead/, sweep terminal,
   * sweep dead/ by age and count, fill free slots.
   */
  tick(): void {
    const now = this.now();
    try {
      this.deps.dueTriggers?.(now);
    } catch (err) {
      // The scheduler failing must not stop the queue it feeds.
      log.warn(`Due triggers: ${errorMessage(err)}`);
    }
    for (const dead of expireQueue(
      this.deps.dirs,
      now,
      this.deps.config.ttlMs
    )) {
      log.warn(
        `Dead request ${dead.request.id} (${dead.request.key}): ${dead.reason}`
      );
    }
    sweepLedger(this.deps.dirs, now, this.deps.config.retentionMs);
    sweepDead(this.deps.dirs, now, this.deadCaps);
    this.fill();
  }

  /**
   * Moves a claim that died before it had a branch into dead/, freeing its
   * slot. Only this line counts: an interrupted, exhausted, aborted or
   * verify-red run already has a branch, a PR and a trailer.
   */
  private bury(
    entry: LedgerEntry,
    stage: Extract<DeathStage, 'base' | 'launch'>,
    reason: string
  ): void {
    log.warn(
      `Dead request ${entry.id} (${entry.request?.key ?? 'no key'}): ${reason}`
    );
    buryLedgerEntry(this.deps.dirs, entry, {
      stage,
      reason,
      diedAt: this.now().toISOString(),
    });
  }

  /** Slots held: triggered runs in the ledger that have not ended. A manual spawn holds none. */
  heldSlots(): number {
    return listLedger(this.deps.dirs).filter(
      entry => entry.slot && !isTerminalLedgerState(entry.state)
    ).length;
  }

  /**
   * Triggers that own a ledger entry that has not ended: what `overlap:
   * "skip"` checks at fire time. Never `queue/`, which is the dedup's.
   */
  liveTriggers(): Set<string> {
    const live = new Set<string>();
    for (const entry of listLedger(this.deps.dirs)) {
      const trigger = entry.request?.trigger;
      if (trigger !== undefined && !isTerminalLedgerState(entry.state)) {
        live.add(trigger);
      }
    }
    return live;
  }

  /** Claims the oldest requests into free slots and starts their runs. */
  fill(): void {
    let free = this.deps.config.slots - this.heldSlots();
    for (const request of listQueue(this.deps.dirs)) {
      if (free <= 0) break;
      const entry = claimRequest(this.deps.dirs, request.key, this.now());
      // Another consumer won the rename: not ours, and no slot taken.
      if (!entry) continue;
      // A claim that dies before it launches holds no slot.
      if (this.launch(entry)) free -= 1;
    }
  }

  /**
   * At start only: every entry that has not ended is checked by container
   * name. No container (or none yet, for a claim `serve` never got to start)
   * is `interrupted`; a running one keeps its slot.
   */
  reconcile(): void {
    for (const entry of listLedger(this.deps.dirs)) {
      if (isTerminalLedgerState(entry.state)) continue;
      if (entry.container && this.deps.containerRunning(entry.container)) {
        log.info(
          `Ledger: ${entry.id} (${entry.run ?? 'no branch yet'}) is still running; leaving it, not streaming it`
        );
        continue;
      }
      log.warn(
        `Ledger: ${entry.id} (${entry.run ?? 'no branch yet'}) lost its container while serve was down; interrupted, not retried`
      );
      this.end(entry.id, {
        state: 'interrupted',
        error: 'e serve restarted and found no running container for this run',
      });
    }
  }

  /** Resolves the claim's base and starts its run; false when it died instead. */
  private launch(entry: LedgerEntry): boolean {
    const request = entry.request as RunRequest;
    const file = ledgerFile(this.deps.dirs, entry.id);
    if (this.deps.resolveBase) {
      // The base rule, before a child exists: a base that does not resolve
      // is a dead request with a clear reason, not a confusing checkout
      // error. Anything else that fails here is a launch failure.
      let base: RunBase;
      try {
        base = this.deps.resolveBase(request.base, request.repo);
      } catch (err) {
        const reason = errorMessage(err);
        this.bury(entry, isBaseError(err) ? 'base' : 'launch', reason);
        return false;
      }
      patchLedgerFile(file, { base });
    }
    const spawnRequest = {
      id: request.id,
      agent: request.agent,
      prompt: request.prompt,
      requestedAt: request.enqueuedAt,
    };
    let child: ChildHandle;
    try {
      child = (this.deps.launch ?? spawnChildProcess)({
        request: spawnRequest,
        args: childCliArgs(spawnRequest, [
          ...(request.repo !== undefined && this.deps.servingRoot !== undefined
            ? [SPAWN_FLAGS.dir, this.deps.servingRoot]
            : []),
          ...(this.deps.passthroughArgs ?? []),
        ]),
        ...(request.repo !== undefined ? { cwd: request.repo } : {}),
        env: { ...env.withLedger(file), ...provenanceEnv(request) },
        logFile: path.join(this.deps.dirs.logs, `${request.id}.log`),
        spoolDir: this.deps.dirs.live,
      });
    } catch (err) {
      this.bury(
        entry,
        'launch',
        `could not start the run: ${errorMessage(err)}`
      );
      return false;
    }
    log.info(`Started ${request.id} (${request.key}) as ${request.agent}`);
    this.children.set(entry.id, child);
    child.exited.then(
      code => this.onExit(entry.id, code),
      err => this.onExit(entry.id, 1, errorMessage(err))
    );
    return true;
  }

  /**
   * The child is gone: an entry it never ended is failed, which frees its
   * slot. A run that failed before it had a branch - an image build, a
   * malformed agent - is a dead request; one with a branch stays in the
   * ledger, since its branch, PR and trailer already say what happened.
   */
  private onExit(id: string, code: number, reason?: string): void {
    this.children.delete(id);
    let entry = readLedgerEntry(this.deps.dirs, id);
    if (entry && !isTerminalLedgerState(entry.state)) {
      this.end(id, {
        state: 'failed',
        exitCode: code,
        error:
          reason ??
          `the e spawn process exited with code ${code} before ending its run`,
      });
      entry = readLedgerEntry(this.deps.dirs, id);
    }
    if (entry?.state === 'failed' && entry.run === null) {
      this.bury(
        entry,
        'launch',
        `failed before its run branch existed: ${entry.error ?? `exit code ${entry.exitCode ?? code}`}`
      );
    }
    // A slot just freed.
    this.fill();
  }

  private end(id: string, patch: Partial<LedgerEntry>): void {
    patchLedgerFile(ledgerFile(this.deps.dirs, id), {
      ...patch,
      endedAt: this.now().toISOString(),
    });
  }
}
