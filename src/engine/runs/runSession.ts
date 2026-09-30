/**
 * **The Run's session on the host** (ADR-0017): where a harness's
 * conversation outlives its `--rm` container, so `e resume` can continue it.
 *
 * ```
 * .e/runs/sessions/<run name>/
 *   session.json   the record: who ran, from which base, with what, how long
 *   harness/       bind-mounted at the harness's `sessionDir`
 * ```
 *
 * In the Store, never under the worktrees dir, so a transcript is never
 * inside `/workspace` and never in a branch; `sessions/` carries its own
 * `.gitignore` for a Store that is partly committed. Directories are 0700 and
 * the record 0600: a transcript holds tool output, and tool output can hold
 * the secrets the Run was given, which `redactSession.ts` masks when the Run
 * ends (#205). A session is kept for
 * {@link SESSION_RETENTION_MS} after its last use, and pruned when the next
 * one is prepared in the same Store.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RunName } from '../../core/identity/runName.js';
import type { Provider } from '../../core/harness/adapter.js';
import { RUNS_DIR } from '../queue/runsSpool.js';

/** `.e/runs/sessions/`, beside the queue spools (ADR-0016 section 6). */
export const SESSIONS_DIR = 'sessions';
const RECORD_FILE = 'session.json';
const TRANSCRIPT_DIR = 'harness';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a session is kept after its last use, in days and in ms. */
export const SESSION_RETENTION_DAYS = 14;
export const SESSION_RETENTION_MS = SESSION_RETENTION_DAYS * DAY_MS;

/** What `e resume` needs to know about the Run a session belongs to. */
export interface RunSessionRecord {
  /** The Run's branch, `e/<agent>/<slug>-N`. */
  branch: string;
  agent: string;
  /** The harness that wrote the transcript: a different one cannot read it. */
  harness: string;
  /** Its pinned version when the session was last used. */
  harnessVersion: string;
  /** The provider the Run talked to, for the drift warning; absent for a default agent. */
  provider?: { baseUrl: string; model: string; protocol: string };
  /** What the Run was cut from and the branch its PR targets. */
  base: { sha: string; branch: string };
  /** The `--mcp` servers the Run was started with, started again on resume. */
  mcp: string[];
  /** The per-run `--skill`s, mounted again on resume. */
  skills: string[];
  /** Wall clock spent by every non-interactive invocation so far (ADR-0016 caps). */
  elapsedMs: number;
  createdAt: string;
  updatedAt: string;
}

/** The part of a record the spawn plan knows before the Run has an identity. */
export type RunSessionInit = Pick<
  RunSessionRecord,
  'agent' | 'harness' | 'harnessVersion' | 'provider' | 'mcp' | 'skills'
>;

/** A session made ready for a container: where to mount, and what it records. */
export interface OpenRunSession {
  dir: string;
  /** The host dir the harness's `sessionDir` is bind-mounted from. */
  transcriptDir: string;
  record: RunSessionRecord;
}

/** `.e/runs/sessions/` of the Store whose `.e/` is `storeDir`. */
export function sessionsDirFor(storeDir: string): string {
  return path.join(storeDir, RUNS_DIR, SESSIONS_DIR);
}

/** The session directory of `run`. */
export function runSessionDirFor(storeDir: string, run: RunName): string {
  return path.join(sessionsDirFor(storeDir), run.name);
}

function recordPath(storeDir: string, run: RunName): string {
  return path.join(runSessionDirFor(storeDir, run), RECORD_FILE);
}

/** A 0700 directory, whatever the umask made of it. */
function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Temp + rename, 0600 from the first byte. */
function writeRecord(file: string, record: RunSessionRecord): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.renameSync(tmp, file);
}

function isRecord(value: unknown): value is RunSessionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  const base = r.base as Record<string, unknown> | undefined;
  return (
    typeof r.branch === 'string' &&
    typeof r.agent === 'string' &&
    typeof r.harness === 'string' &&
    typeof r.harnessVersion === 'string' &&
    typeof base?.sha === 'string' &&
    typeof base?.branch === 'string' &&
    Array.isArray(r.mcp) &&
    Array.isArray(r.skills) &&
    typeof r.elapsedMs === 'number' &&
    typeof r.createdAt === 'string' &&
    typeof r.updatedAt === 'string'
  );
}

/** The record of `run`'s session, or undefined when there is none (or it is unreadable). */
export function readRunSession(
  storeDir: string,
  run: RunName
): RunSessionRecord | undefined {
  return readRecordFile(recordPath(storeDir, run));
}

/** The record in `file`, or undefined when it is absent or not a record. */
function readRecordFile(file: string): RunSessionRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

/**
 * The provider facts a record keeps for the drift warning: where and what,
 * never the key's name. One spelling for the plan that writes it and the
 * resume that compares against it.
 */
export function sessionProvider(
  provider: Provider | undefined
): RunSessionRecord['provider'] {
  return provider
    ? {
        baseUrl: provider.baseUrl,
        model: provider.model,
        protocol: provider.protocol,
      }
    : undefined;
}

/** True once the harness has written anything into `run`'s transcript dir. */
export function hasSessionTranscript(storeDir: string, run: RunName): boolean {
  const walk = (dir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some(entry =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.isFile()
    );
  };
  return walk(path.join(runSessionDirFor(storeDir, run), TRANSCRIPT_DIR));
}

/**
 * Makes `run`'s session ready to mount: the directories, the `.gitignore`
 * and the record. A session that exists already (a resume) keeps its base,
 * its creation time and its wall clock, and takes the agent as it is now,
 * so the next resume compares against what last ran.
 */
export function openRunSession(
  storeDir: string,
  run: RunName,
  params: { init: RunSessionInit; base: RunSessionRecord['base'] },
  now: Date = new Date()
): OpenRunSession {
  const sessions = sessionsDirFor(storeDir);
  privateDir(sessions);
  const ignore = path.join(sessions, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  const dir = runSessionDirFor(storeDir, run);
  const transcriptDir = path.join(dir, TRANSCRIPT_DIR);
  privateDir(dir);
  privateDir(transcriptDir);
  const existing = readRunSession(storeDir, run);
  const record: RunSessionRecord = {
    ...params.init,
    branch: run.branch,
    base: existing?.base ?? params.base,
    elapsedMs: existing?.elapsedMs ?? 0,
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  };
  writeRecord(recordPath(storeDir, run), record);
  return { dir, transcriptDir, record };
}

/** Adds `ms` to the wall clock `run`'s session has spent; nothing without a record. */
export function addSessionElapsed(
  storeDir: string,
  run: RunName,
  ms: number,
  now: Date = new Date()
): void {
  const record = readRunSession(storeDir, run);
  if (!record) return;
  writeRecord(recordPath(storeDir, run), {
    ...record,
    elapsedMs: record.elapsedMs + Math.max(0, Math.round(ms)),
    updatedAt: now.toISOString(),
  });
}

/**
 * Deletes every session last used more than `maxAgeMs` before `now` - by its
 * record's `updatedAt`, or by the directory's mtime when it has no readable
 * record. Returns the run names removed. Best-effort per entry: one that
 * cannot be removed is left for the next prune.
 */
export function pruneRunSessions(
  storeDir: string,
  now: Date = new Date(),
  maxAgeMs: number = SESSION_RETENTION_MS
): string[] {
  const sessions = sessionsDirFor(storeDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessions, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(sessions, entry.name);
    try {
      const record = readRecordFile(path.join(dir, RECORD_FILE));
      const lastUsed = record
        ? Date.parse(record.updatedAt)
        : fs.statSync(dir).mtimeMs;
      if (now.getTime() - lastUsed <= maxAgeMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // Left for the next prune.
    }
  }
  return removed;
}
