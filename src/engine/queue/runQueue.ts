/**
 * **The `serve` tick** (ADR-0016 section 6): the one consumer of the run
 * queue, and the one place a slot is counted.
 *
 * One interval of 30 s, in fixed order - reconcile (at start only), expire,
 * sweep terminal, fill free slots - plus an immediate fill on enqueue, so a
 * triggered run does not wait an interval on an idle box. A claimed request
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
 * Due triggers (the scheduler) and the dead-request spool land on top of
 * this; until then a request that expires is dropped and logged.
 */

import path from 'node:path';
import type { QueueConfig } from '../../core/store/config.js';
import { env } from '../../shared/utils/env.js';
import { log } from '../../shared/utils/log.js';
import { errorMessage } from '../../shared/utils/errors.js';
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
  sweepLedger,
  type EnqueueResult,
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
  /** True while a container of this name is running: what a restart checks entries against. */
  containerRunning(name: string): boolean;
  /** Starts a claimed request's `e spawn` child; defaults to re-invoking this CLI. */
  launch?: ChildLauncher;
  /** `e spawn` arguments every child inherits (`--dir`, `--env-file`). */
  passthroughArgs?: readonly string[];
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
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => Date;

  constructor(private readonly deps: RunQueueDeps) {
    this.now = deps.now ?? (() => new Date());
    ensureRunsDirs(deps.dirs);
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
        this.fill();
        break;
      case 'duplicate':
        log.info(`Not queued: ${full.key} is already pending`);
        break;
      case 'full':
        // Rejected, never dropped-oldest: that would discard work already accepted.
        log.warn(
          `Not queued: the queue is full (${this.deps.config.maxLength} waiting); ${full.key} rejected`
        );
        break;
    }
    return result;
  }

  /** One pass after start: expire, sweep terminal, fill free slots. */
  tick(): void {
    const now = this.now();
    for (const expired of expireQueue(
      this.deps.dirs,
      now,
      this.deps.config.ttlMs
    )) {
      log.warn(
        `Dropped ${expired.id} (${expired.key}): waited past the queue TTL, never started`
      );
    }
    sweepLedger(this.deps.dirs, now, this.deps.config.retentionMs);
    this.fill();
  }

  /** Slots held: triggered runs in the ledger that have not ended. A manual spawn holds none. */
  heldSlots(): number {
    return listLedger(this.deps.dirs).filter(
      entry => entry.slot && !isTerminalLedgerState(entry.state)
    ).length;
  }

  /** Claims the oldest requests into free slots and starts their runs. */
  fill(): void {
    let free = this.deps.config.slots - this.heldSlots();
    for (const request of listQueue(this.deps.dirs)) {
      if (free <= 0) break;
      const entry = claimRequest(this.deps.dirs, request.key, this.now());
      // Another consumer won the rename: not ours, and no slot taken.
      if (!entry) continue;
      free -= 1;
      this.launch(entry);
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

  private launch(entry: LedgerEntry): void {
    const request = entry.request as RunRequest;
    const file = ledgerFile(this.deps.dirs, entry.id);
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
        args: childCliArgs(spawnRequest, this.deps.passthroughArgs),
        env: { ...env.withLedger(file), ...provenanceEnv(request) },
        logFile: path.join(this.deps.dirs.logs, `${request.id}.log`),
        spoolDir: this.deps.dirs.live,
      });
    } catch (err) {
      this.end(entry.id, {
        state: 'failed',
        error: `could not start the run: ${errorMessage(err)}`,
      });
      return;
    }
    log.info(`Started ${request.id} (${request.key}) as ${request.agent}`);
    this.children.set(entry.id, child);
    child.exited.then(
      code => this.onExit(entry.id, code),
      err => this.onExit(entry.id, 1, errorMessage(err))
    );
  }

  /** The child is gone: an entry it never ended is failed, which frees its slot. */
  private onExit(id: string, code: number, reason?: string): void {
    this.children.delete(id);
    const entry = readLedgerEntry(this.deps.dirs, id);
    if (entry && !isTerminalLedgerState(entry.state)) {
      this.end(id, {
        state: 'failed',
        exitCode: code,
        error:
          reason ??
          `the e spawn process exited with code ${code} before ending its run`,
      });
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
