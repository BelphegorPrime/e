/**
 * **Collecting a settled candidate** (ADR-0019 section 5): turning what the
 * coordinator knows about one finished Candidate run into its Candidate
 * result, its patch and its files, in the fusion record.
 *
 * The envelope is built from the spool's facts and host-side git only, never
 * from anything the candidate wrote about itself, and it is written **last**:
 * an envelope on disk means its patch and files are complete.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { HarnessAgent } from '../../core/agent/agent.js';
import {
  CANDIDATE_FILES_DIR,
  CANDIDATE_PATCH_FILE,
  CANDIDATE_RESULT_VERSION,
  candidateOutcome,
  type CandidateEnd,
  type CandidateResult,
  type CandidateUsage,
  type ChangedFile,
} from '../../core/fusion/result.js';
import type { Git } from '../../ports/git/index.js';
import { prepareCandidateDir, writeCandidateResult } from './record.js';

/**
 * The patch budget: enough for any change a reviewer would read as one
 * piece, small enough that a lockfile rewrite cannot fill the record.
 */
export const PATCH_MAX_BYTES = 2 * 1024 * 1024;
/**
 * The files budget: much larger, so a candidate whose patch was cut can
 * still be read file by file (the synthesis container has no git).
 */
export const FILES_MAX_BYTES = 32 * 1024 * 1024;

/** The whole repository, as a pathspec: numstat needs one. */
const WHOLE_REPOSITORY = ':/';

/** What the coordinator knows about one candidate attempt once it has ended. */
export interface SettledCandidate {
  /** The Fusion run, `fusion-<ulid>`. */
  fusion: string;
  /** This attempt's spool record id, `cand-NNN`. */
  candidate: string;
  /** The candidate's Agent, as the profile resolved it. */
  agent: HarnessAgent;
  /** The harness's pinned version (`HARNESSES[...].version`). */
  harnessVersion: string;
  /** The image the run used, when the coordinator knows it. */
  image?: string;
  /** The MCP servers the run was planned with; the Agent's skills come with it. */
  mcp?: string[];
  /** The fusion's pinned base and the branch a PR targets. */
  base: { sha: string; branch: string };
  /** The run branch, once the run had one. */
  branch?: string;
  /** The run's exit code, once it reported one. */
  exitCode?: number;
  /** Set when the fusion stopped it: its deadline or a cancel. */
  stoppedBy?: CandidateEnd['stoppedBy'];
  /** Why the run ended as it did: a `LoopReason`, or a fusion's. */
  reason?: string;
  /** The repository's check, for a gated run. */
  verify?: CandidateResult['verify'];
  /** 1 for the first attempt. */
  attempt: number;
  /** The record id of the attempt this one retries. */
  retryOf?: string;
  startedAt: Date;
  endedAt: Date;
  /** Only ever as a harness reported it. */
  usage?: CandidateUsage;
  /**
   * Set when an earlier collect of this attempt failed reading its branch:
   * collected again without git, as `failed` with the reason
   * `aborted:collect-failed`, so one unreadable candidate costs the fusion
   * that candidate and nothing else.
   */
  unreadable?: boolean;
}

/** The reason of a candidate whose branch could not be read. */
export const COLLECT_FAILED_REASON = 'aborted:collect-failed';

/** The byte budgets of one collect; the defaults are {@link PATCH_MAX_BYTES} and {@link FILES_MAX_BYTES}. */
export interface CollectBudgets {
  patchMaxBytes?: number;
  filesMaxBytes?: number;
}

/**
 * Collects one settled candidate into the fusion record of the Store whose
 * `.e/` directory is `storeDir`, and returns the envelope it wrote. `git`
 * is the repository the candidate's branch was cut in.
 */
export function collectCandidateResult(
  git: Git,
  storeDir: string,
  settled: SettledCandidate,
  budgets: CollectBudgets = {}
): CandidateResult {
  const dir = prepareCandidateDir(storeDir, settled.fusion, settled.candidate);
  // The full ref for both questions, so a tag of the same name answers neither.
  const ref =
    settled.branch === undefined ? undefined : `refs/heads/${settled.branch}`;
  const tip =
    !settled.unreadable &&
    ref !== undefined &&
    git.hasCommitsBeyondBase(ref, settled.base.sha)
      ? (git.resolveCommit(ref) ?? null)
      : null;

  let files: ChangedFile[] = [];
  let patchTruncated = false;
  let filesTruncated = false;
  if (tip !== null) {
    files = git
      .numstat(settled.base.sha, tip, [WHOLE_REPOSITORY])
      .map(({ path: file, from, added, removed }) =>
        from === undefined
          ? { path: file, added, removed }
          : { path: file, from, added, removed }
      );
    const diff = git.diff(
      settled.base.sha,
      tip,
      budgets.patchMaxBytes ?? PATCH_MAX_BYTES
    );
    fs.writeFileSync(path.join(dir, CANDIDATE_PATCH_FILE), diff.patch, {
      mode: 0o600,
    });
    patchTruncated = diff.truncated;
    const filesDir = path.join(dir, CANDIDATE_FILES_DIR);
    fs.mkdirSync(filesDir, { mode: 0o700 });
    filesTruncated = git.exportFiles(
      tip,
      files.map(file => file.path),
      filesDir,
      budgets.filesMaxBytes ?? FILES_MAX_BYTES
    ).truncated;
  }

  const { agent } = settled;
  const result: CandidateResult = {
    schemaVersion: CANDIDATE_RESULT_VERSION,
    fusion: settled.fusion,
    candidate: settled.candidate,
    agent: agent.name,
    harness: { name: agent.harness, version: settled.harnessVersion },
    // What the Agent declared; its endpoint and key name stay in the Agent.
    provider: agent.provider
      ? { protocol: agent.provider.protocol, model: agent.provider.model }
      : null,
    skills: [...(agent.skills ?? [])],
    mcp: [...(settled.mcp ?? [])],
    base: { ...settled.base },
    branch: settled.branch ?? null,
    tip,
    changes: {
      files,
      added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
      removed: files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
    },
    patch: tip === null ? null : CANDIDATE_PATCH_FILE,
    patchTruncated,
    files: tip === null ? null : CANDIDATE_FILES_DIR,
    filesTruncated,
    outcome: settled.unreadable
      ? 'failed'
      : candidateOutcome({
          exitCode: settled.exitCode,
          stoppedBy: settled.stoppedBy,
          // A branch that stopped resolving has nothing a synthesizer could read.
          hasCommits: tip !== null,
        }),
    exitCode: settled.exitCode ?? null,
    reason: settled.unreadable
      ? COLLECT_FAILED_REASON
      : (settled.reason ?? null),
    attempt: settled.attempt,
    retryOf: settled.retryOf ?? null,
    startedAt: settled.startedAt.toISOString(),
    endedAt: settled.endedAt.toISOString(),
    elapsedMs: Math.max(
      0,
      settled.endedAt.getTime() - settled.startedAt.getTime()
    ),
    usage: settled.usage ? { ...settled.usage } : null,
  };
  if (settled.image !== undefined) result.harness.image = settled.image;
  if (settled.verify !== undefined) result.verify = { ...settled.verify };
  writeCandidateResult(dir, result);
  return result;
}
