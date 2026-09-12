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
  SPOOL_REQUESTS_DIR,
  SPOOL_RUN_FILE,
  SPOOL_STATUS_DIR,
} from './constants.js';
import type {
  BrokerRunInfo,
  SiblingRecord,
  SiblingStatusPatch,
  SpawnRequest,
} from './types.js';

/** Request ids are `sib-NNN`; the shape is checked before it becomes a file name. */
const REQUEST_ID_RE = /^sib-\d{3,}$/;

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

/** The next id in the sequence: `sib-001`, `sib-002`, ... (max existing + 1). */
export function nextRequestId(root: string): string {
  let max = 0;
  for (const id of listRequestIds(root)) {
    max = Math.max(max, Number(id.slice('sib-'.length)));
  }
  return `sib-${String(max + 1).padStart(3, '0')}`;
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

/** A request merged with its status; `requested` until the host writes one. */
export function readRecord(
  root: string,
  id: string
): SiblingRecord | undefined {
  const request = readRequest(root, id);
  if (!request) return undefined;
  const status = readStatus(root, id);
  return status
    ? { ...request, ...status }
    : { ...request, status: 'requested' };
}

export function listRecords(root: string): SiblingRecord[] {
  return listRequestIds(root)
    .map(id => readRecord(root, id))
    .filter((record): record is SiblingRecord => record !== undefined);
}
