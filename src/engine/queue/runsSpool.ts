/**
 * **The run queue and the ledger** (ADR-0016 section 6): two file-backed
 * spools under the serving Store, gitignored with the rest of `.e/`.
 *
 * - `.e/runs/queue/` holds pending **requests** - no branch, no identity yet.
 *   One file per request, named by its dedup key, so the filesystem is the
 *   dedup: a second request with a pending key cannot be created.
 * - `.e/runs/live/` is the **ledger**: runs that exist, from claim to
 *   terminal-within-retention, one file per run named by its request id.
 * - `.e/runs/dead/` holds **dead requests**: those that died before a run
 *   branch existed - TTL expiry, overflow, an unresolvable `base`, a launch
 *   failure. Not a DLQ: nothing consumes it, there is no receive count, and a
 *   redrive is a human act. Named by request id, since one key can die twice.
 *
 * The broker spool's discipline, reused rather than reinvented: every write is
 * temp + rename (or temp + link, where the write must not replace anything),
 * and a corrupt or half-written file reads as **absent**. The payload lives
 * **inline** in the record, so a claim is one rename and a crash can never
 * leave a record whose payload went missing.
 *
 * No queue library and no database: the claim **is**
 * `rename(queue/<key>, live/<id>)` - whoever wins the rename owns the job -
 * the maximum length is a `readdir` count, the TTL a field and a sweep, and
 * ordering the request id's ULID. The live file is named by the id rather than
 * the key because a claimed key is free for the next request at once, and the
 * two must not share a file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { monotonicFactory } from 'ulid';
import {
  readJson,
  writeJsonAtomic,
} from '../../sidecars/broker/contract/spool.js';
import type { DeadConfig, LoopCaps } from '../../core/store/config.js';
import type { GateRemovals } from '../runs/gateRemovals.js';
import type { ProvenanceEvent } from '../../core/trigger/provenance.js';
import type { RunBase } from '../runs/runSpawn.js';

/** `.e/runs/`, and its three parts. */
export const RUNS_DIR = 'runs';
export const QUEUE_DIR = 'queue';
export const LIVE_DIR = 'live';
export const DEAD_DIR = 'dead';
/** Where a queued run's `e spawn` child writes its output. */
export const RUN_LOGS_DIR = 'logs';

/** The directories of one Store's run spools. */
export interface RunsDirs {
  queue: string;
  live: string;
  dead: string;
  logs: string;
}

/** The run spools of the Store whose `.e/` directory is `storeDir`. */
export function runsDirs(storeDir: string): RunsDirs {
  const root = path.join(storeDir, RUNS_DIR);
  return {
    queue: path.join(root, QUEUE_DIR),
    live: path.join(root, LIVE_DIR),
    dead: path.join(root, DEAD_DIR),
    logs: path.join(root, RUN_LOGS_DIR),
  };
}

/** Creates the spool layout (idempotent). */
export function ensureRunsDirs(dirs: RunsDirs): void {
  for (const dir of [dirs.queue, dirs.live, dirs.dead, dirs.logs]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Request ids: `trg-<ulid>` for a triggered request, `man-<ulid>` for the
 * ledger entry a manual `e spawn` writes. Monotonic, because two triggers can
 * fire in the same millisecond; `crypto.randomUUID({ version: 7 })` would be
 * the builtin, but Node 24.15 ignores the option and returns a v4.
 */
const nextUlid = monotonicFactory();

export function newRequestId(kind: 'trg' | 'man' = 'trg'): string {
  return `${kind}-${nextUlid()}`;
}

/** A bare ULID from the same factory: an id for what has no request, a one-shot run's event. */
export function newUlid(): string {
  return nextUlid();
}

/** The ULID a request id carries, what acceptance substitutes for an event id it refuses. */
export function requestUlid(id: string): string {
  return id.slice(id.indexOf('-') + 1);
}

const REQUEST_ID_RE = /^(trg|man)-[0-9A-HJKMNP-TV-Z]{26}$/;

export function isRunRequestId(value: string): boolean {
  return REQUEST_ID_RE.test(value);
}

/**
 * Where a triggered request came from, as the `E-Event` trailer names it.
 * Validated before the queue file is written (see {@link RunQueue.enqueue}).
 */
export type RequestEvent = ProvenanceEvent;

/** A pending trigger request: everything a run needs, and nothing named yet. */
export interface RunRequest {
  /** `trg-<ulid>`: names the request, never the run (ADR-0003 is untouched). */
  id: string;
  /** `<trigger id>:<event dedup value>`; the queue file's name, once sanitized. */
  key: string;
  /** The trigger that fired. */
  trigger: string;
  agent: string;
  /** The rendered prompt, identifiers only interpolated. */
  prompt: string;
  /** The branch the run cuts from. */
  base?: string;
  /** The trigger's field-wise `loop` override. */
  loop?: Partial<LoopCaps>;
  event?: RequestEvent;
  /** The event's page, derived from validated identifiers at acceptance; for the PR block. */
  eventUrl?: string;
  /** The event payload, inline: a sidecar file would end the one-rename claim. */
  payload?: unknown;
  enqueuedAt: string;
}

/** The states of a run in the ledger; `queued` is a request, not yet here. */
export type LedgerState =
  'claimed' | 'running' | 'done' | 'failed' | 'interrupted';

/** States nothing more will happen in. */
export const TERMINAL_LEDGER_STATES: readonly LedgerState[] = [
  'done',
  'failed',
  'interrupted',
];

export function isTerminalLedgerState(state: LedgerState): boolean {
  return TERMINAL_LEDGER_STATES.includes(state);
}

/** A run in the ledger. */
export interface LedgerEntry {
  /** The request id: `trg-<ulid>` for a triggered run, `man-<ulid>` for a manual spawn. */
  id: string;
  state: LedgerState;
  /** Whether this run holds one of `serve`'s slots: triggered runs do, a manual spawn never. */
  slot: boolean;
  agent: string;
  /** The run branch; null until the run has one. */
  run: string | null;
  /** The run container's name, what a restart checks the entry against. */
  container?: string;
  /** The base `serve` resolved at claim; the run's `e spawn` cuts from it. */
  base?: RunBase;
  /** For a triggered run, the request it was claimed from, payload included. */
  request?: RunRequest;
  claimedAt?: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  /** A gated run's verdict and its reason (ADR-0016 section 4). */
  outcome?: string;
  reason?: string;
  pushed?: boolean;
  pullRequestUrl?: string;
  /** Lines removed under `verify.guards` (section 11): for the human's eyes. */
  gateRemovals?: GateRemovals;
  error?: string;
}

/** A dedup key as a file name: anything outside `[A-Za-z0-9._-]` percent-encoded, so no two keys collide. */
export function keyFileName(key: string): string {
  const safe = key.replace(
    /[^A-Za-z0-9._-]/g,
    ch =>
      '%' +
      [...Buffer.from(ch, 'utf8')]
        .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
        .join('%')
  );
  return `${safe}.json`;
}

/** The `*.json` records of `dir`, never a temp file. */
function recordFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter(name => name.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

/** Why an enqueue did not take the request. */
export type EnqueueResult =
  | { status: 'enqueued'; request: RunRequest }
  /** A request with this key is already pending. */
  | { status: 'duplicate' }
  /** `maxLength` requests are waiting; the new one is rejected, never the oldest. */
  | { status: 'full' };

/**
 * Adds a request, unless its key is pending or the queue is full. The write
 * must not replace anything, so it is temp + **link**: `link` fails when the
 * name exists, which is what makes the key the dedup and one process's
 * duplicate check race-free.
 */
export function enqueueRequest(
  dirs: RunsDirs,
  request: RunRequest,
  maxLength: number
): EnqueueResult {
  ensureRunsDirs(dirs);
  if (recordFiles(dirs.queue).length >= maxLength) return { status: 'full' };
  const file = path.join(dirs.queue, keyFileName(request.key));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(request, null, 2) + '\n');
  try {
    fs.linkSync(tmp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { status: 'duplicate' };
    }
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { status: 'enqueued', request };
}

/** A pending request, or `undefined` when the file is not a usable one. */
function asRequest(value: unknown): RunRequest | undefined {
  const r = value as Partial<RunRequest> | undefined;
  if (
    !r ||
    typeof r.id !== 'string' ||
    !isRunRequestId(r.id) ||
    typeof r.key !== 'string' ||
    typeof r.agent !== 'string' ||
    typeof r.prompt !== 'string' ||
    typeof r.enqueuedAt !== 'string'
  ) {
    return undefined;
  }
  return r as RunRequest;
}

/** Every pending request, oldest first (by its ULID); a corrupt file reads as absent. */
export function listQueue(dirs: RunsDirs): RunRequest[] {
  return recordFiles(dirs.queue)
    .map(name => asRequest(readJson(path.join(dirs.queue, name))))
    .filter((r): r is RunRequest => r !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Claims the pending request under `key`: `rename(queue/<key>, live/<id>)`,
 * then rewrites the live file as a {@link LedgerEntry} in `claimed`. Of two
 * concurrent claims exactly one rename succeeds; the other gets `undefined`.
 * A crash between the two steps leaves a live file holding the bare request,
 * which {@link readLedgerEntry} reads as `claimed`.
 */
export function claimRequest(
  dirs: RunsDirs,
  key: string,
  now: Date
): LedgerEntry | undefined {
  const from = path.join(dirs.queue, keyFileName(key));
  const request = asRequest(readJson(from));
  if (!request) return undefined;
  const to = path.join(dirs.live, `${request.id}.json`);
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const entry = claimedEntry(request, now.toISOString());
  writeJsonAtomic(to, entry);
  return entry;
}

function claimedEntry(request: RunRequest, claimedAt: string): LedgerEntry {
  return {
    id: request.id,
    state: 'claimed',
    slot: true,
    agent: request.agent,
    run: null,
    request,
    claimedAt,
  };
}

/** The ledger file of the run `id`. */
export function ledgerFile(dirs: RunsDirs, id: string): string {
  return path.join(dirs.live, `${id}.json`);
}

/** Reads a ledger file; a bare request (a claim cut short) reads as `claimed`, garbage as absent. */
export function readLedgerFile(file: string): LedgerEntry | undefined {
  const value = readJson<Partial<LedgerEntry>>(file);
  if (!value || typeof value.id !== 'string') return undefined;
  if (value.state === undefined) {
    const request = asRequest(value);
    return request ? claimedEntry(request, request.enqueuedAt) : undefined;
  }
  if (typeof value.agent !== 'string' || typeof value.slot !== 'boolean') {
    return undefined;
  }
  return value as LedgerEntry;
}

export function readLedgerEntry(
  dirs: RunsDirs,
  id: string
): LedgerEntry | undefined {
  return readLedgerFile(ledgerFile(dirs, id));
}

/** Every run in the ledger, oldest first; a corrupt file reads as absent. */
export function listLedger(dirs: RunsDirs): LedgerEntry[] {
  return recordFiles(dirs.live)
    .map(name => readLedgerFile(path.join(dirs.live, name)))
    .filter((e): e is LedgerEntry => e !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Merges `patch` into a ledger file, atomically. Only ever written by one
 * process at a time for a given run - `serve` at claim and after, or the run's
 * own `e spawn` - so read-modify-write needs no lock.
 */
export function patchLedgerFile(
  file: string,
  patch: Partial<LedgerEntry>
): void {
  const current = readLedgerFile(file);
  if (!current) return;
  writeJsonAtomic(file, { ...current, ...patch });
}

/** Writes a new ledger entry (a manual spawn's), atomically. */
export function writeLedgerEntry(dirs: RunsDirs, entry: LedgerEntry): string {
  ensureRunsDirs(dirs);
  const file = ledgerFile(dirs, entry.id);
  writeJsonAtomic(file, entry);
  return file;
}

/**
 * Moves pending requests older than `ttlMs` from `enqueuedAt` into `dead/`,
 * unstarted: a webhook event from three days ago is stale. A rename, so
 * every exit from `queue/` is one; the record is then rewritten as a
 * {@link DeadRequest}, and a crash in between leaves the bare request, which
 * {@link readDeadFile} reads as expired. Queue entries only - a run in the
 * ledger is bounded by its own caps. Returns what died.
 */
export function expireQueue(
  dirs: RunsDirs,
  now: Date,
  ttlMs: number
): DeadRequest[] {
  const expired: DeadRequest[] = [];
  for (const request of listQueue(dirs)) {
    const age = now.getTime() - Date.parse(request.enqueuedAt);
    if (!(age > ttlMs)) continue;
    const dead = buryFile(
      dirs,
      path.join(dirs.queue, keyFileName(request.key)),
      request,
      {
        stage: 'expired',
        reason: expiredReason(ttlMs),
        diedAt: now.toISOString(),
      }
    );
    if (dead) expired.push(dead);
  }
  return expired;
}

/**
 * Removes terminal ledger entries whose `endedAt` is older than
 * `retentionMs`: the ledger is what is running and what just ended, never an
 * archive. Returns the ids swept.
 */
export function sweepLedger(
  dirs: RunsDirs,
  now: Date,
  retentionMs: number
): string[] {
  const swept: string[] = [];
  for (const entry of listLedger(dirs)) {
    if (!isTerminalLedgerState(entry.state) || !entry.endedAt) continue;
    if (now.getTime() - Date.parse(entry.endedAt) <= retentionMs) continue;
    fs.rmSync(ledgerFile(dirs, entry.id), { force: true });
    swept.push(entry.id);
  }
  return swept;
}

/** Where a request died, before any run branch existed. */
export type DeathStage = 'expired' | 'overflow' | 'base' | 'launch';

/** How a request died: where, why and when. */
export interface Death {
  stage: DeathStage;
  reason: string;
  diedAt: string;
}

/** A dead request: the request, payload inline, and how it died. */
export interface DeadRequest extends Death {
  request: RunRequest;
}

/** Why an expired request died; the TTL when it is known. */
export function expiredReason(ttlMs?: number): string {
  return `waited past the queue TTL${ttlMs !== undefined ? ` (${ttlMs} ms)` : ''}, never started`;
}

/** The dead-request file of the request `id`. */
export function deadFile(dirs: RunsDirs, id: string): string {
  return path.join(dirs.dead, `${id}.json`);
}

/** Reads a dead file; a bare request (an expiry cut short) reads as expired, garbage as absent. */
export function readDeadFile(file: string): DeadRequest | undefined {
  const value = readJson<Partial<DeadRequest>>(file);
  if (!value) return undefined;
  if (value.request === undefined) {
    const request = asRequest(value);
    return request
      ? {
          request,
          stage: 'expired',
          reason: expiredReason(),
          diedAt: request.enqueuedAt,
        }
      : undefined;
  }
  const request = asRequest(value.request);
  if (
    !request ||
    typeof value.stage !== 'string' ||
    typeof value.reason !== 'string' ||
    typeof value.diedAt !== 'string'
  ) {
    return undefined;
  }
  return { ...(value as DeadRequest), request };
}

/** Every dead request, oldest death first; a corrupt file reads as absent. */
export function listDead(dirs: RunsDirs): DeadRequest[] {
  return recordFiles(dirs.dead)
    .map(name => readDeadFile(path.join(dirs.dead, name)))
    .filter((d): d is DeadRequest => d !== undefined)
    .sort(
      (a, b) =>
        a.diedAt.localeCompare(b.diedAt) ||
        a.request.id.localeCompare(b.request.id)
    );
}

/** The dead request `id`, or undefined. */
export function readDeadRequest(
  dirs: RunsDirs,
  id: string
): DeadRequest | undefined {
  return readDeadFile(deadFile(dirs, id));
}

/**
 * Renames `from` into `dead/` and rewrites it as a dead request. Undefined
 * when another process renamed it first.
 */
function buryFile(
  dirs: RunsDirs,
  from: string,
  request: RunRequest,
  death: Death
): DeadRequest | undefined {
  ensureRunsDirs(dirs);
  const to = deadFile(dirs, request.id);
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const dead: DeadRequest = { request, ...death };
  writeJsonAtomic(to, dead);
  return dead;
}

/**
 * Writes a request that never entered `queue/` - an overflow rejection -
 * straight into `dead/`: the one way in that is not a rename.
 */
export function writeDeadRequest(dirs: RunsDirs, dead: DeadRequest): string {
  ensureRunsDirs(dirs);
  const file = deadFile(dirs, dead.request.id);
  writeJsonAtomic(file, dead);
  return file;
}

/**
 * Moves a claimed run that never got a branch from the ledger into `dead/`:
 * its base did not resolve, or it failed to launch. Undefined for an entry
 * with no request (a manual spawn) or one already gone.
 */
export function buryLedgerEntry(
  dirs: RunsDirs,
  entry: LedgerEntry,
  death: Death
): DeadRequest | undefined {
  if (!entry.request) return undefined;
  return buryFile(dirs, ledgerFile(dirs, entry.id), entry.request, death);
}

/**
 * Sweeps `dead/` by age, then by count, **oldest first**: a record of loss is
 * the one thing that may lose its oldest record. Returns the ids swept.
 */
export function sweepDead(
  dirs: RunsDirs,
  now: Date,
  caps: DeadConfig
): string[] {
  const swept: string[] = [];
  const kept: DeadRequest[] = [];
  for (const dead of listDead(dirs)) {
    if (now.getTime() - Date.parse(dead.diedAt) > caps.maxAgeMs) {
      fs.rmSync(deadFile(dirs, dead.request.id), { force: true });
      swept.push(dead.request.id);
    } else {
      kept.push(dead);
    }
  }
  for (const dead of kept.slice(0, Math.max(0, kept.length - caps.maxCount))) {
    fs.rmSync(deadFile(dirs, dead.request.id), { force: true });
    swept.push(dead.request.id);
  }
  return swept;
}

/**
 * Puts a redriven request back into `queue/` under its key - refused, like any
 * enqueue, when the key is pending or the queue is full - and only then
 * removes the dead record `deadId`, so a refusal loses nothing.
 */
export function redriveRequest(
  dirs: RunsDirs,
  deadId: string,
  request: RunRequest,
  maxLength: number
): EnqueueResult {
  const result = enqueueRequest(dirs, request, maxLength);
  if (result.status === 'enqueued') {
    fs.rmSync(deadFile(dirs, deadId), { force: true });
  }
  return result;
}

/** The pending request under `key`, or undefined. */
export function pendingRequest(
  dirs: RunsDirs,
  key: string
): RunRequest | undefined {
  return asRequest(readJson(path.join(dirs.queue, keyFileName(key))));
}
