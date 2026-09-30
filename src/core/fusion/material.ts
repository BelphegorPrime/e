import fs from 'fs';
import path from 'path';
import { isAgentName } from '../agent/agent.js';
import { errorMessage } from '../../shared/utils/errors.js';
import { fromBranch } from '../identity/runName.js';
import { FUSION_NAME_PATTERN } from './profile.js';
import {
  CANDIDATE_OUTCOMES,
  isCandidateId,
  isCandidateReason,
  isFusionId,
  type CandidateOutcome,
  type CandidateResult,
} from './result.js';

/**
 * **The synthesis material** (ADR-0019 section 7): what the synthesis run is
 * given, read-only at {@link FUSION_MOUNT_PATH}, outside its worktree -
 *
 * ```
 * /run/e/fusion/
 *   fusion.json               this summary
 *   candidates/<cand-NNN>/    result.json, patch.diff, files/ - every candidate
 * ```
 *
 * The summary is the one place the synthesis run's host side reads the
 * fusion from: its PR block is built from it, from **identifiers only**
 * (#149's rule), so nothing a candidate wrote can reach a rendered PR. It is
 * checked field by field for that reason.
 */

/** Where the material is mounted in the synthesis container, beside `/run/e/event.json`. */
export const FUSION_MOUNT_PATH = '/run/e/fusion';
/** The summary's file name at the top of the material. */
export const FUSION_MATERIAL_FILE = 'fusion.json';
/** The directory the candidates' copies are in. */
export const FUSION_MATERIAL_CANDIDATES_DIR = 'candidates';

/** One candidate, as the summary names it. */
export interface MaterialCandidate {
  candidate: string;
  agent: string;
  outcome: CandidateOutcome;
  reason: string | null;
  verify: 'green' | 'red' | 'broken' | null;
  /** The pushed run branch; `null` when there is nothing on the remote to point at. */
  branch: string | null;
  /** Commits beyond the base, whatever the verdict. */
  usable: boolean;
}

/** The summary at the top of the material. */
export interface FusionMaterial {
  schemaVersion: 1;
  fusion: string;
  /** The profile's id. */
  profile: string;
  synthesizer: string;
  base: { sha: string; branch: string };
  /** The user's task, verbatim: what the PR body shows under its block. */
  task: string;
  candidates: MaterialCandidate[];
}

/** The summary for a closed fan-out: every candidate, and the branch of each one that was pushed. */
export function materialSummary(input: {
  fusion: string;
  profile: string;
  synthesizer: string;
  base: { sha: string; branch: string };
  task: string;
  candidates: readonly CandidateResult[];
  pushed: readonly string[];
}): FusionMaterial {
  return {
    schemaVersion: 1,
    fusion: input.fusion,
    profile: input.profile,
    synthesizer: input.synthesizer,
    base: { sha: input.base.sha, branch: input.base.branch },
    task: input.task,
    candidates: input.candidates.map(result => ({
      candidate: result.candidate,
      agent: result.agent,
      outcome: result.outcome,
      reason: result.reason,
      verify: result.verify?.verdict ?? null,
      branch:
        result.branch !== null && input.pushed.includes(result.branch)
          ? result.branch
          : null,
      usable: result.tip !== null,
    })),
  };
}

/** A commit id: what `base.sha` may be. */
const SHA = /^[0-9a-f]{7,64}$/;
/** A branch name as git allows one, never a path out of anything. */
const BRANCH = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._/-]{1,200}$/;

/**
 * Reads a summary, refusing any field that is not the identifier it should
 * be: the PR block is rendered, and a value here that is not an identifier
 * is prose. `where` names the source in errors.
 */
export function parseFusionMaterial(
  raw: unknown,
  where: string
): FusionMaterial {
  const fail = (why: string): never => {
    throw new Error(`Invalid fusion material at ${where}: ${why}`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('must be a JSON object');
  }
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 1) fail('schemaVersion is not 1');
  const str = (value: unknown, field: string, ok: (s: string) => boolean) =>
    typeof value === 'string' && ok(value)
      ? value
      : fail(`"${field}" is not a valid value`);
  const base = (r.base ?? {}) as Record<string, unknown>;
  if (!Array.isArray(r.candidates)) fail('"candidates" must be an array');
  const candidates = (r.candidates as unknown[]).map((entry, i) => {
    const c = (entry ?? {}) as Record<string, unknown>;
    const at = `candidates[${i}]`;
    if (!CANDIDATE_OUTCOMES.includes(c.outcome as CandidateOutcome)) {
      fail(`"${at}.outcome" is not a valid value`);
    }
    if (
      c.verify !== null &&
      !['green', 'red', 'broken'].includes(c.verify as string)
    ) {
      fail(`"${at}.verify" is not a valid value`);
    }
    if (typeof c.usable !== 'boolean') fail(`"${at}.usable" must be a boolean`);
    return {
      candidate: str(c.candidate, `${at}.candidate`, isCandidateId),
      agent: str(c.agent, `${at}.agent`, isAgentName),
      outcome: c.outcome as CandidateOutcome,
      reason:
        c.reason === null
          ? null
          : str(c.reason, `${at}.reason`, isCandidateReason),
      verify: c.verify as MaterialCandidate['verify'],
      branch:
        c.branch === null
          ? null
          : str(c.branch, `${at}.branch`, b => fromBranch(b) !== undefined),
      usable: c.usable as boolean,
    };
  });
  return {
    schemaVersion: 1,
    fusion: str(r.fusion, 'fusion', isFusionId),
    profile: str(r.profile, 'profile', p => FUSION_NAME_PATTERN.test(p)),
    synthesizer: str(r.synthesizer, 'synthesizer', isAgentName),
    base: {
      sha: str(base.sha, 'base.sha', s => SHA.test(s)),
      branch: str(base.branch, 'base.branch', b => BRANCH.test(b)),
    },
    // The one prose field: the user's own task, shown under the block as a
    // manual run's PR shows its prompt, never inside it.
    task: str(r.task, 'task', t => t.trim() !== ''),
    candidates,
  };
}

/** The summary at the top of the material in `dir`, read and checked field by field. */
export function readFusionMaterial(dir: string): FusionMaterial {
  const file = path.join(dir, FUSION_MATERIAL_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(
      `Cannot read the fusion material at ${file}: ${errorMessage(err)}`,
      { cause: err }
    );
  }
  return parseFusionMaterial(raw, file);
}

/**
 * The fusion lines of the synthesis PR's block (ADR-0019 section 8): the
 * profile, the pinned base, each candidate's Agent, outcome, verify verdict
 * and pushed branch, and the synthesizer - identifiers only.
 */
export function fusionBlockLines(material: FusionMaterial): string[] {
  const lines = [
    `Fusion: ${material.fusion} · profile ${material.profile} · base ${material.base.sha.slice(0, 12)} (${material.base.branch})`,
    `Synthesizer: ${material.synthesizer}`,
  ];
  for (const c of material.candidates) {
    const parts = [
      c.agent,
      c.reason ? `${c.outcome} (${c.reason})` : c.outcome,
      ...(c.verify ? [`verify ${c.verify}`] : []),
      ...(c.branch ? [c.branch] : []),
    ];
    lines.push(`Candidate ${c.candidate}: ${parts.join(' · ')}`);
  }
  return lines;
}
