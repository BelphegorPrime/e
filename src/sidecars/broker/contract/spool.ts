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
 */
export const REQUEST_ID_PREFIXES = ['sib', 'a2a'] as const;
export type RequestIdPrefix = (typeof REQUEST_ID_PREFIXES)[number];
const REQUEST_ID_RE = /^(sib|a2a)-\d{3,}$/;

export function isRequestId(value: string): boolean {
  return REQUEST_ID_RE.test(value);
}

/** Creates the spool layout under `root` (idempotent). */
export function ensureSpool(root: string): void {
  fs.mkdirSync(path.join(root, SPOOL_REQUESTS_DIR), { recursive: true });
  fs.mkdirSync(path.join(root, SPOOL_STATUS_DIR), { recursive: true });
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
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
  prefix: RequestIdPrefix = 'sib'
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
    throw new Error(`Invalid request id "${request.id}".`);
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

/** The host's side: records how far a request got. */
export function writeStatus(
  root: string,
  id: string,
  patch: SiblingStatusPatch
): void {
  if (!isRequestId(id)) throw new Error(`Invalid request id "${id}".`);
  writeJsonAtomic(path.join(root, SPOOL_STATUS_DIR, `${id}.json`), patch);
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
  if (!isRequestId(id)) throw new Error(`Invalid request id "${id}".`);
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  writeJsonAtomic(path.join(root, dir, `${id}.json`), { id, signaledAt: at });
}

function hasSignal(root: string, dir: string, id: string): boolean {
  return isRequestId(id) && fs.existsSync(path.join(root, dir, `${id}.json`));
}

function takeSignal(root: string, dir: string, id: string): boolean {
  if (!hasSignal(root, dir, id)) return false;
  fs.rmSync(path.join(root, dir, `${id}.json`), { force: true });
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

/** True if a merge signal for `id` is waiting (not yet taken by the host). */
export function hasMergeSignal(root: string, id: string): boolean {
  return hasSignal(root, SPOOL_SIGNALS_DIR, id);
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

/** True if a cancel for `id` is waiting (not yet taken by the host). */
export function hasCancelSignal(root: string, id: string): boolean {
  return hasSignal(root, SPOOL_CANCELS_DIR, id);
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
