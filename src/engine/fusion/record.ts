/**
 * **The fusion record on the host** (ADR-0019 section 6): where each Fusion
 * run keeps what its candidates produced, so a synthesizer can read them and
 * so they outlive the coordinator that wrote them.
 *
 * ```
 * .e/runs/fusions/<fusion id>/
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
