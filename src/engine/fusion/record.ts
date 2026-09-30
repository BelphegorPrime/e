/**
 * **The fusion record on the host** (ADR-0019 section 6): where each Fusion
 * run keeps what its candidates produced, so a synthesizer can read them and
 * so they outlive the coordinator that wrote them.
 *
 * ```
 * .e/runs/fusions/<fusion id>/
 *   fusion.json               the record: profile, Agents, prompt, base, state
 *   candidates/<record id>/   one per attempt, cand-NNN
 *     result.json             the Candidate result
 *     patch.diff
 *     files/                  the tip content of the changed files
 * ```
 *
 * In the checkout's Store beside `sessions/` and the queue spools, never
 * under the worktrees dir, which is the temp dir on Linux and would lose the
 * results to a reboot. `fusions/` carries its own `.gitignore`, directories
 * are 0700 and files 0600, and no container ever mounts this directory.
 * The envelope is written last and atomically, so an envelope on disk means
 * its patch and files are complete; a candidate directory without one is
 * what a crash mid-collect left.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  CANDIDATE_RESULT_FILE,
  isCandidateId,
  isFusionId,
  parseCandidateResult,
  type CandidateResult,
} from '../../core/fusion/result.js';
import type { FusionProfile } from '../../core/fusion/profile.js';
import type { RunBase } from '../runs/runSpawn.js';
import { errorMessage } from '../../shared/utils/errors.js';
import {
  privateDir,
  privateIgnoredDir,
  writePrivateFileAtomic,
} from '../../shared/utils/privateFs.js';
import { RUNS_DIR } from '../queue/runsSpool.js';

/** `.e/runs/fusions/`, beside `sessions/` and the queue spools. */
export const FUSIONS_DIR = 'fusions';
const CANDIDATES_DIR = 'candidates';

/** `.e/runs/fusions/` of the Store whose `.e/` directory is `storeDir`. */
export function fusionsDirFor(storeDir: string): string {
  return path.join(storeDir, RUNS_DIR, FUSIONS_DIR);
}

/** One Fusion run's record directory; refuses anything that is not a fusion id. */
export function fusionRecordDirFor(storeDir: string, fusion: string): string {
  if (!isFusionId(fusion)) {
    throw new Error(`"${fusion}" is not a fusion id (fusion-<ulid>)`);
  }
  return path.join(fusionsDirFor(storeDir), fusion);
}

/** One candidate attempt's directory; refuses anything that is not a record id. */
export function candidateDirFor(
  storeDir: string,
  fusion: string,
  candidate: string
): string {
  const record = fusionRecordDirFor(storeDir, fusion);
  if (!isCandidateId(candidate)) {
    throw new Error(`"${candidate}" is not a candidate id (cand-NNN)`);
  }
  return path.join(record, CANDIDATES_DIR, candidate);
}

/**
 * Makes an empty directory for one candidate attempt and returns it, with
 * every directory above it private and `fusions/` git-ignored. What an
 * earlier, crashed collect left there is removed - half of an attempt is
 * worth nothing - but a finished one is refused: ids are never reused, so an
 * envelope already there is one this call must not destroy.
 */
export function prepareCandidateDir(
  storeDir: string,
  fusion: string,
  candidate: string
): string {
  const dir = candidateDirFor(storeDir, fusion, candidate);
  if (fs.existsSync(path.join(dir, CANDIDATE_RESULT_FILE))) {
    throw new Error(
      `${candidate} of ${fusion} is already collected; a candidate id is never reused`
    );
  }
  privateIgnoredDir(fusionsDirFor(storeDir));
  privateDir(fusionRecordDirFor(storeDir, fusion));
  privateDir(path.dirname(dir));
  fs.rmSync(dir, { recursive: true, force: true });
  privateDir(dir);
  return dir;
}

/**
 * Writes the envelope into a candidate's directory: checked by its own
 * reader first, then temp + rename, 0600 from the first byte.
 */
export function writeCandidateResult(
  dir: string,
  result: CandidateResult
): void {
  const file = path.join(dir, CANDIDATE_RESULT_FILE);
  // Nothing is written that the synthesizer's side would refuse to read.
  parseCandidateResult(result, file);
  writePrivateFileAtomic(file, JSON.stringify(result, null, 2) + '\n');
}

/** One candidate directory of a record: its envelope, or why there is none. */
export interface LoadedCandidateResult {
  candidate: string;
  result?: CandidateResult;
  error?: string;
}

/**
 * Every candidate attempt a Fusion run's record holds, by record id - what a
 * restarted coordinator, a synthesis mount or an evaluation reads. A
 * directory without an envelope, or with one this `e` cannot read, is an
 * entry with its reason, never a throw.
 */
export function readCandidateResults(
  storeDir: string,
  fusion: string
): LoadedCandidateResult[] {
  const dir = path.join(fusionRecordDirFor(storeDir, fusion), CANDIDATES_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && isCandidateId(entry.name))
    .map(entry => entry.name)
    .sort()
    .map(candidate => {
      const file = path.join(dir, candidate, CANDIDATE_RESULT_FILE);
      if (!fs.existsSync(file)) {
        return {
          candidate,
          error: `incomplete: no ${CANDIDATE_RESULT_FILE} (its collect did not finish)`,
        };
      }
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        const result = parseCandidateResult(raw, file);
        // A copied or mis-filed envelope must not be read under another id.
        if (result.fusion !== fusion || result.candidate !== candidate) {
          return {
            candidate,
            error: `${file} is ${result.fusion}/${result.candidate}, not ${fusion}/${candidate}`,
          };
        }
        return { candidate, result };
      } catch (err) {
        return { candidate, error: errorMessage(err) };
      }
    });
}

// --- fusion.json: the record of one Fusion run (ADR-0019 sections 3, 6) -----

/** The record's file name inside a Fusion run's directory. */
const FUSION_RECORD_FILE = 'fusion.json';

/** How long an ended Fusion run's record is kept: the retention of a Session (ADR-0017). */
export const FUSION_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Where a Fusion run is (ADR-0019 section 3). `fanning-out` holds from the
 * first launch until the synthesis starts; `interrupted` is what a record
 * becomes whose coordinator died while it was live.
 */
export const FUSION_STATES = [
  'prepared',
  'fanning-out',
  'synthesizing',
  'completed',
  'failed',
  'canceled',
  'exhausted',
  'interrupted',
] as const;
export type FusionState = (typeof FUSION_STATES)[number];

const TERMINAL: readonly FusionState[] = [
  'completed',
  'failed',
  'canceled',
  'exhausted',
  'interrupted',
];

/** True for a state a Fusion run never leaves. */
export function isTerminalFusionState(state: FusionState): boolean {
  return TERMINAL.includes(state);
}

/** One Agent as it ran, snapshotted so the record still reproduces it after an edit. Never a key or an endpoint. */
export interface FusionAgentSnapshot {
  name: string;
  harness: string;
  harnessVersion: string;
  provider: { protocol: string; model: string } | null;
  skills: string[];
}

/** `fusion.json`: one Fusion run, from its prompt to its end. */
export interface FusionRecord {
  schemaVersion: 1;
  fusion: string;
  state: FusionState;
  /** Why it ended as it did, as the Verdict spells a reason. */
  reason?: string;
  /** The profile as it was loaded, defaults resolved. */
  profile: FusionProfile;
  /** Every distinct Agent the profile named, as resolved. */
  agents: FusionAgentSnapshot[];
  prompt: string;
  /** The pinned base: its commit, full ref and the branch a PR targets. */
  base: RunBase;
  /** The candidate attempts' record ids, in launch order. */
  candidates: string[];
  /** Set when the fan-out closed: how many candidates are usable, and what was pushed. */
  fanOut?: {
    closedAt: string;
    usable: number;
    pushed: string[];
    pushWarnings: string[];
  };
  /** Set when the synthesis started: its spool record id and Agent; `synthesis.json` has its end. */
  synthesis?: { id: string; agent: string };
  /** The process driving it, so a later one can tell a live record from a dead one. */
  coordinator: { pid: number };
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

function fusionRecordFile(storeDir: string, fusion: string): string {
  return path.join(fusionRecordDirFor(storeDir, fusion), FUSION_RECORD_FILE);
}

/** Writes `fusion.json`, temp + rename, 0600, in a private, git-ignored record. */
export function writeFusionRecord(
  storeDir: string,
  record: FusionRecord
): void {
  privateIgnoredDir(fusionsDirFor(storeDir));
  privateDir(fusionRecordDirFor(storeDir, record.fusion));
  writePrivateFileAtomic(
    fusionRecordFile(storeDir, record.fusion),
    JSON.stringify(record, null, 2) + '\n'
  );
}

/**
 * `fusion.json` of one Fusion run, or undefined when there is none or it is
 * not one this `e` wrote: a record that cannot be read is never guessed at.
 */
export function readFusionRecord(
  storeDir: string,
  fusion: string
): FusionRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(
      fs.readFileSync(fusionRecordFile(storeDir, fusion), 'utf8')
    );
  } catch {
    return undefined;
  }
  const r = raw as Partial<FusionRecord> | null;
  if (
    r === null ||
    typeof r !== 'object' ||
    r.schemaVersion !== 1 ||
    r.fusion !== fusion ||
    !FUSION_STATES.includes(r.state as FusionState) ||
    typeof r.coordinator?.pid !== 'number' ||
    typeof r.updatedAt !== 'string'
  ) {
    return undefined;
  }
  return r as FusionRecord;
}

/** The Fusion run ids with a directory in this Store's record, sorted. */
export function listFusionIds(storeDir: string): string[] {
  const dir = fusionsDirFor(storeDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && isFusionId(entry.name))
    .map(entry => entry.name)
    .sort();
}

/** True while the process `pid` exists (signal 0 checks, sends nothing). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is merely someone else's.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Marks every live record whose coordinator is gone `interrupted`, and
 * returns their ids (ADR-0019 section 6). Nothing is resumed: the envelopes
 * already written are kept, and the branches finished candidates left stay
 * where they are. A record whose coordinator still runs is left alone, so
 * two `e fuse` in one Store never interrupt each other.
 */
export function reconcileFusions(
  storeDir: string,
  opts: { isAlive?: (pid: number) => boolean; now?: Date } = {}
): string[] {
  const isAlive = opts.isAlive ?? processAlive;
  const now = (opts.now ?? new Date()).toISOString();
  const interrupted: string[] = [];
  for (const fusion of listFusionIds(storeDir)) {
    const record = readFusionRecord(storeDir, fusion);
    if (!record || isTerminalFusionState(record.state)) continue;
    if (isAlive(record.coordinator.pid)) continue;
    writeFusionRecord(storeDir, {
      ...record,
      state: 'interrupted',
      updatedAt: now,
      endedAt: now,
    });
    interrupted.push(fusion);
  }
  return interrupted;
}

/**
 * Removes every ended record older than {@link FUSION_RETENTION_MS}, with
 * everything in it, and returns their ids. A live record is never pruned,
 * and neither is a directory without a readable record: nothing says when
 * it ended.
 */
export function pruneFusions(
  storeDir: string,
  now: Date = new Date(),
  retentionMs: number = FUSION_RETENTION_MS
): string[] {
  const pruned: string[] = [];
  for (const fusion of listFusionIds(storeDir)) {
    const record = readFusionRecord(storeDir, fusion);
    if (!record || !isTerminalFusionState(record.state)) continue;
    const ended = Date.parse(record.endedAt ?? record.updatedAt);
    if (!(now.getTime() - ended > retentionMs)) continue;
    fs.rmSync(fusionRecordDirFor(storeDir, fusion), {
      recursive: true,
      force: true,
    });
    pruned.push(fusion);
  }
  return pruned;
}

// --- synthesis.json: how the synthesis run ended (ADR-0019 section 6) -------

const SYNTHESIS_RECORD_FILE = 'synthesis.json';

/** `synthesis.json`: the synthesis run of one Fusion run, once it has ended. */
export interface SynthesisRecord {
  schemaVersion: 1;
  fusion: string;
  /** Its spool record id, `syn-NNN`. */
  id: string;
  agent: string;
  /** The run branch; absent when the run died before it had one. */
  branch?: string;
  /** The run's Verdict (ADR-0016), or 143 for a cancel. */
  exitCode: number;
  reason?: string;
  verify?: { verdict: 'green' | 'red' | 'broken'; attempts: number };
  /** Why it failed without a verdict: a launch that did not start, a process that never reported. */
  error?: string;
  pushed: boolean;
  pullRequestUrl?: string;
  canceled: boolean;
  startedAt: string;
  endedAt: string;
}

/** Writes `synthesis.json` beside `fusion.json`, temp + rename, 0600. */
export function writeSynthesisRecord(
  storeDir: string,
  record: SynthesisRecord
): void {
  privateDir(fusionRecordDirFor(storeDir, record.fusion));
  writePrivateFileAtomic(
    path.join(
      fusionRecordDirFor(storeDir, record.fusion),
      SYNTHESIS_RECORD_FILE
    ),
    JSON.stringify(record, null, 2) + '\n'
  );
}

/** `synthesis.json` of one Fusion run, or undefined when there is none or it is not one this `e` wrote. */
export function readSynthesisRecord(
  storeDir: string,
  fusion: string
): SynthesisRecord | undefined {
  try {
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(fusionRecordDirFor(storeDir, fusion), SYNTHESIS_RECORD_FILE),
        'utf8'
      )
    ) as Partial<SynthesisRecord> | null;
    return raw?.schemaVersion === 1 && raw.fusion === fusion
      ? (raw as SynthesisRecord)
      : undefined;
  } catch {
    return undefined;
  }
}
