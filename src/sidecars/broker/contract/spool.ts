/**
 * The broker **spool**: a directory the host bind-mounts into the broker
 * container. It is the only channel between the two - the broker writes one
 * file per sibling request, the host writes one file per status, and both
 * sides read the other's files. Files are written atomically (temp + rename),
 * so a reader never sees a half-written JSON document.
 *
 * Node built-ins only: this module is bundled into the container server and
 * also used by the host `e` process.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  SPOOL_CANCELS_DIR,
  SPOOL_LOGS_DIR,
  SPOOL_REQUESTS_DIR,
  SPOOL_RUN_FILE,
  SPOOL_SIGNALS_DIR,
  SPOOL_STATUS_DIR,
} from './constants.js';
import { taskStateOf } from './taskState.js';
import type {
  BrokerRunInfo,
  SiblingRecord,
  SiblingState,
  SiblingStatusPatch,
  SpawnRequest,
} from './types.js';

/**
 * Request ids are `<prefix>-NNN`: `sib-` for a sibling the broker accepted,
 * `a2a-` for a task the A2A facade on `e serve` started (ADR-0015). The shape
 * is checked before it becomes a file name.
 *
 * The prefixes, the pattern and the error message all derive from
 * {@link REQUEST_ID_PREFIXES} below, so the only way to add a third kind of
 * request is to add it there - and the message can never describe a format
 * the check does not enforce.
 */
const REQUEST_ID_PREFIXES = ['sib', 'a2a'] as const;
const REQUEST_ID_DIGITS = 3;
const REQUEST_ID_RE = new RegExp(
  `^(${REQUEST_ID_PREFIXES.join('|')})-\\d{${REQUEST_ID_DIGITS},}$`
);

/** The required shape, spelled out for an error message. */
const REQUEST_ID_SHAPE = `${REQUEST_ID_PREFIXES.map(p => `${p}-`).join(' or ')}followed by at least ${REQUEST_ID_DIGITS} digits, e.g. "${REQUEST_ID_PREFIXES[0]}-001"`;

export function isRequestId(value: string): boolean {
  return REQUEST_ID_RE.test(value);
}

/**
 * The error for an id that is not one. The broker generates ids itself, so
 * only a direct spool writer ever sees this - a scripted child in a test, an
 * operator poking the spool, a tool calling these helpers - and none of them
 * can guess the format from the id alone.
 */
function invalidRequestId(id: string): Error {
  return new Error(`Invalid request id "${id}": expected ${REQUEST_ID_SHAPE}.`);
}

/** Creates the spool layout under `root` (idempotent). */
export function ensureSpool(root: string): void {
  fs.mkdirSync(path.join(root, SPOOL_REQUESTS_DIR), { recursive: true });
  fs.mkdirSync(path.join(root, SPOOL_STATUS_DIR), { recursive: true });
  fs.mkdirSync(path.join(root, SPOOL_LOGS_DIR), { recursive: true });
}

/**
 * Where a request's child process writes its output: `logs/<id>.log`. The
 * host launches the process and the failure message quotes the tail of this
 * file, so the path belongs here with the rest of the spool layout.
 */
export function spoolLogPath(root: string, id: string): string {
  if (!isRequestId(id)) throw invalidRequestId(id);
  return path.join(root, SPOOL_LOGS_DIR, `${id}.log`);
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/**
 * Reads one spool file, or `undefined` when there is nothing usable there.
 *
 * A corrupt or half-written file reads as **absent**, never as an exception.
 * The host polls this spool in a loop while a run's agent works, so a single
 * unreadable file must not take sibling handling down for the whole run - the
 * next poll retries, and by then the writer has usually finished. Every
 * production writer goes through {@link writeJsonAtomic} (temp + rename) so
 * this should not happen; nothing enforces that, which is exactly why the
 * reader does not depend on it.
 */
function readJson<T>(file: string): T | undefined {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    // Absent, or vanished between the read and this call.
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function writeRunInfo(root: string, info: BrokerRunInfo): void {
  writeJsonAtomic(path.join(root, SPOOL_RUN_FILE), info);
}

export function readRunInfo(root: string): BrokerRunInfo | null {
  return readJson<BrokerRunInfo>(path.join(root, SPOOL_RUN_FILE)) ?? null;
}

/** The ids of every spooled request, in arrival order. */
export function listRequestIds(root: string): string[] {
  const dir = path.join(root, SPOOL_REQUESTS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => name.slice(0, -'.json'.length))
    .filter(isRequestId)
    .sort();
}

/** The next id in the sequence for `prefix`: `sib-001`, `sib-002`, ... (max existing + 1). */
export function nextRequestId(
  root: string,
  prefix: 'sib' | 'a2a' = 'sib'
): string {
  let max = 0;
  for (const id of listRequestIds(root)) {
    if (!id.startsWith(`${prefix}-`)) continue;
    max = Math.max(max, Number(id.slice(prefix.length + 1)));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

/** Spools a request; refuses to overwrite an existing id. */
export function writeRequest(root: string, request: SpawnRequest): void {
  if (!isRequestId(request.id)) {
    throw invalidRequestId(request.id);
  }
  const file = path.join(root, SPOOL_REQUESTS_DIR, `${request.id}.json`);
  if (fs.existsSync(file)) {
    throw new Error(`Request "${request.id}" already exists.`);
  }
  writeJsonAtomic(file, request);
}

export function readRequest(
  root: string,
  id: string
): SpawnRequest | undefined {
  if (!isRequestId(id)) return undefined;
  return readJson<SpawnRequest>(
    path.join(root, SPOOL_REQUESTS_DIR, `${id}.json`)
  );
}

/**
 * The host's side: records how far a request got. A **patch**, as its type
 * says - the fields given are merged over whatever the record already holds,
 * so a later write never drops what an earlier one recorded (a run reports
 * `done` with its `pushed` and PR/MR url; a cancel racing it still leaves
 * them in place). No field can be cleared once set, which is the shape the
 * record has anyway: a request only ever moves forward.
 */
export function writeStatus(
  root: string,
  id: string,
  patch: SiblingStatusPatch
): void {
  if (!isRequestId(id)) throw invalidRequestId(id);
  const file = path.join(root, SPOOL_STATUS_DIR, `${id}.json`);
  const previous = readJson<SiblingStatusPatch>(file);
  writeJsonAtomic(file, previous ? { ...previous, ...patch } : patch);
}

export function readStatus(
  root: string,
  id: string
): SiblingStatusPatch | undefined {
  if (!isRequestId(id)) return undefined;
  return readJson<SiblingStatusPatch>(
    path.join(root, SPOOL_STATUS_DIR, `${id}.json`)
  );
}

/**
 * A **signal** is a one-shot file the broker writes for the parent agent and
 * the host takes (removes) when it acts on it: a merge signal (ticket 07)
 * or a cancel (ADR-0015). One helper set, two directories.
 */
function writeSignal(root: string, dir: string, id: string, at: string): void {
  if (!isRequestId(id)) throw invalidRequestId(id);
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  writeJsonAtomic(path.join(root, dir, `${id}.json`), { id, signaledAt: at });
}

function takeSignal(root: string, dir: string, id: string): boolean {
  if (!isRequestId(id)) return false;
  const file = path.join(root, dir, `${id}.json`);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

/**
 * The parent agent's signal that sibling `id`'s merge-back may be retried
 * (ticket 07): its files are cleared, or the conflict markers resolved. The
 * broker writes it for `POST /merge/<id>`; the host takes it when it retries.
 */
export function signalMerge(root: string, id: string, at: string): void {
  writeSignal(root, SPOOL_SIGNALS_DIR, id, at);
}

/** Consumes the merge signal for `id`: true if there was one (it is removed). */
export function takeMergeSignal(root: string, id: string): boolean {
  return takeSignal(root, SPOOL_SIGNALS_DIR, id);
}

/**
 * The parent agent's cancel of sibling `id` (ADR-0015): the broker writes it
 * for `POST /cancel/<id>`; the host takes it and stops the sibling (or never
 * starts it), then writes `canceled`.
 */
export function signalCancel(root: string, id: string, at: string): void {
  writeSignal(root, SPOOL_CANCELS_DIR, id, at);
}

/** Consumes the cancel for `id`: true if there was one (it is removed). */
export function takeCancelSignal(root: string, id: string): boolean {
  return takeSignal(root, SPOOL_CANCELS_DIR, id);
}

/** A request merged with its status (`requested` until the host writes one) and its A2A task state. */
export function readRecord(
  root: string,
  id: string
): SiblingRecord | undefined {
  const request = readRequest(root, id);
  if (!request) return undefined;
  const status = readStatus(root, id);
  const merged = status
    ? { ...request, ...status }
    : { ...request, status: 'requested' as const };
  return { ...merged, taskState: taskStateOf(merged) };
}

export function listRecords(root: string): SiblingRecord[] {
  return listRequestIds(root)
    .map(id => readRecord(root, id))
    .filter((record): record is SiblingRecord => record !== undefined);
}

/** How many requests are in one of `states` - the fan-out count, defined once for broker and host. */
export function countInFlight(
  root: string,
  states: readonly SiblingState[]
): number {
  return listRecords(root).filter(record => states.includes(record.status))
    .length;
}
