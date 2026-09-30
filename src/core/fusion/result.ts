/**
 * The **Candidate result** (ADR-0019 section 5): the envelope the host writes
 * for one settled Candidate run, and the only thing about a candidate a
 * synthesizer reads besides its patch and files.
 *
 * **Neutral by construction.** Every field is something `e` knows for every
 * harness - the Agent and its declared provider, the pinned harness version,
 * git's view of the branch, the exit code, the clock - so no field needs an
 * adapter to parse a harness's output, and one reader serves every provider.
 *
 * **Human-facing fields stay out.** `gateRemovals` (ADR-0016 section 11) and
 * a judge's answers (ADR-0018) are never here: an agent reads this, and a
 * counted signal handed to an agent teaches it to launder the thing counted.
 *
 * **Versioning.** `schemaVersion` is an integer. A reader refuses a version
 * it does not know rather than guessing; within a version it ignores fields
 * it does not know, because adding an optional field is not a new version,
 * while changing or removing one is. The same holds for values: a new
 * `outcome` or verify verdict changes what a synthesizer must understand, so
 * it is a new version, while `provider.protocol` is read as any name, since
 * a provider `e` learns to speak later changes nothing a reader decides on.
 */

/** The version this code writes and the only one it reads. */
export const CANDIDATE_RESULT_VERSION = 1;

/** The envelope's file name inside a candidate's record directory. */
export const CANDIDATE_RESULT_FILE = 'result.json';
/** The patch beside it: `git diff <base> <tip>`, cut at a byte budget. */
export const CANDIDATE_PATCH_FILE = 'patch.diff';
/** The tip content of every changed file, beside it. */
export const CANDIDATE_FILES_DIR = 'files';

/** `fusion-<ulid>`: a Fusion run's id and its record directory's name. */
const FUSION_ID = /^fusion-[0-9A-HJKMNP-TV-Z]{26}$/;
/**
 * `cand-NNN`: a candidate attempt's spool record id and directory name. Never
 * reused within a fusion - a retry is a new id - so a directory once written
 * is never written again.
 */
const CANDIDATE_ID = /^cand-[0-9]{3,}$/;

/**
 * A reason, as the closed vocabulary of the Verdict spells one (ADR-0016's
 * `LoopReason`, ADR-0019 section 8's fusion reasons): never prose, because
 * the envelope is mounted into a synthesizer.
 */
const REASON = /^(?:aborted|exhausted):[a-z][a-z-]*$/;

/** True for a Fusion run id; nothing else may become its record's path. */
export function isFusionId(value: string): boolean {
  return FUSION_ID.test(value);
}

/** True for a candidate attempt's record id. */
export function isCandidateId(value: string): boolean {
  return CANDIDATE_ID.test(value);
}

/** True for a reason the envelope may carry: `aborted:*` or `exhausted:*`. */
export function isCandidateReason(value: string): boolean {
  return REASON.test(value);
}

/**
 * How a candidate ended, divided on what a synthesizer must not confuse:
 * `succeeded` exited 0 with commits; `empty` exited 0 with none, a refusal or
 * a no-op, which every harness reports as success (ADR-0016); `failed` exited
 * non-zero; `timed-out` was stopped by the fusion's `candidatesMs`;
 * `canceled` by a human or `totalMs`.
 */
export const CANDIDATE_OUTCOMES = [
  'succeeded',
  'empty',
  'failed',
  'timed-out',
  'canceled',
] as const;
export type CandidateOutcome = (typeof CANDIDATE_OUTCOMES)[number];

/** The exit code of a canceled run (ADR-0015). */
const CANCELED_EXIT_CODE = 143;

/** What decides a candidate's outcome, as the coordinator sees its end. */
export interface CandidateEnd {
  /** The child's exit code; absent when it never reported one. */
  exitCode?: number;
  /**
   * Set when the fusion itself stopped the candidate, which outranks the
   * code: `candidates-deadline` is the fan-out's `candidatesMs`; `cancel` is
   * a human or the whole fusion's `totalMs`, which are both a cancel to it.
   */
  stoppedBy?: 'candidates-deadline' | 'cancel';
  /** Whether the branch holds commits beyond the fusion's base. */
  hasCommits: boolean;
}

/** The outcome of a candidate that ended as `end` says. */
export function candidateOutcome(end: CandidateEnd): CandidateOutcome {
  if (end.stoppedBy === 'candidates-deadline') return 'timed-out';
  if (end.stoppedBy === 'cancel') return 'canceled';
  if (end.exitCode === CANCELED_EXIT_CODE) return 'canceled';
  if (end.exitCode === 0) return end.hasCommits ? 'succeeded' : 'empty';
  return 'failed';
}

/** One changed file, as `git diff --numstat` counts it; a binary file is `null`. */
export interface ChangedFile {
  path: string;
  /** The path at the base, for a rename. */
  from?: string;
  added: number | null;
  removed: number | null;
}

/** Tokens and cost, only ever as a harness reported them; never estimated. */
export interface CandidateUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/** The envelope, as written to `result.json`. */
export interface CandidateResult {
  schemaVersion: typeof CANDIDATE_RESULT_VERSION;
  /** The Fusion run, `fusion-<ulid>`. */
  fusion: string;
  /** This attempt's record id, `cand-NNN`; also its directory's name. */
  candidate: string;
  /** The Agent's name, as the profile named it. */
  agent: string;
  /** The harness, its pinned version, and the image the run used when known. */
  harness: { name: string; version: string; image?: string };
  /** The Agent's declared provider; `null` for an Agent without one. Never a key or an endpoint. */
  provider: { protocol: string; model: string } | null;
  /** The skills and MCP servers the run was planned with. */
  skills: string[];
  mcp: string[];
  /** The fusion's pinned base and the branch a PR targets. */
  base: { sha: string; branch: string };
  /** The run branch; `null` when the run died before it had one. */
  branch: string | null;
  /** The branch tip; `null` when it holds nothing beyond the base. */
  tip: string | null;
  changes: { files: ChangedFile[]; added: number; removed: number };
  /** `patch.diff` beside this file; `null` when `tip` is. */
  patch: string | null;
  patchTruncated: boolean;
  /** `files/` beside this file; `null` when `tip` is. */
  files: string | null;
  filesTruncated: boolean;
  outcome: CandidateOutcome;
  /** The run's exit code (its Verdict, ADR-0016); `null` when it never reported one. */
  exitCode: number | null;
  /** A `LoopReason`, or a fusion reason; `null` for a plain end. */
  reason: string | null;
  /** The repository's own check, when one is declared. */
  verify?: { verdict: 'green' | 'red' | 'broken'; attempts: number };
  /** The fusion-level attempt of this candidate, 1 for the first. */
  attempt: number;
  /** The record id of the attempt this one retries. */
  retryOf: string | null;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  usage: CandidateUsage | null;
}

/** True when a candidate holds commits beyond the base, whatever its verdict. */
export function isUsable(result: CandidateResult): boolean {
  return result.tip !== null;
}

/**
 * Reads one `result.json` body into a {@link CandidateResult}, refusing an
 * unknown version and any field of the wrong shape, and dropping fields it
 * does not know. `where` names the source in errors.
 */
export function parseCandidateResult(
  raw: unknown,
  where: string
): CandidateResult {
  const fail = (why: string): never => {
    throw new Error(`Invalid candidate result at ${where}: ${why}`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('must be a JSON object');
  }
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== CANDIDATE_RESULT_VERSION) {
    fail(
      `schemaVersion ${JSON.stringify(r.schemaVersion) ?? 'undefined'} is not ${CANDIDATE_RESULT_VERSION}, the only one this e reads`
    );
  }

  const read = new Reader(r, fail);
  const fusion = read.string('fusion');
  if (!isFusionId(fusion)) fail('"fusion" is not a fusion id');
  const candidate = read.string('candidate');
  if (!isCandidateId(candidate)) fail('"candidate" is not a candidate id');

  const harness = read.object('harness');
  const provider = r.provider === null ? null : read.object('provider');
  const base = read.object('base');
  const changes = read.object('changes');
  const outcome = read.string('outcome');
  if (!CANDIDATE_OUTCOMES.includes(outcome as CandidateOutcome)) {
    fail(`unknown outcome ${JSON.stringify(outcome)}`);
  }

  const result: CandidateResult = {
    schemaVersion: CANDIDATE_RESULT_VERSION,
    fusion,
    candidate,
    agent: read.string('agent'),
    harness: {
      name: harness.string('name'),
      version: harness.string('version'),
    },
    provider: provider && {
      protocol: provider.string('protocol'),
      model: provider.string('model'),
    },
    skills: read.strings('skills'),
    mcp: read.strings('mcp'),
    base: { sha: base.string('sha'), branch: base.string('branch') },
    branch: read.nullableString('branch'),
    tip: read.nullableString('tip'),
    changes: {
      files: changes.array('files').map((entry, i) => {
        const file = changes.at('files', i, entry);
        const changed: ChangedFile = {
          path: file.string('path'),
          added: file.nullableCount('added'),
          removed: file.nullableCount('removed'),
        };
        const from = file.optionalString('from');
        if (from !== undefined) changed.from = from;
        return changed;
      }),
      added: changes.count('added'),
      removed: changes.count('removed'),
    },
    patch: read.nullableString('patch'),
    patchTruncated: read.boolean('patchTruncated'),
    files: read.nullableString('files'),
    filesTruncated: read.boolean('filesTruncated'),
    outcome: outcome as CandidateOutcome,
    exitCode: read.nullableInteger('exitCode'),
    reason: read.nullableString('reason'),
    attempt: read.positive('attempt'),
    retryOf: read.nullableString('retryOf'),
    startedAt: read.string('startedAt'),
    endedAt: read.string('endedAt'),
    elapsedMs: read.count('elapsedMs'),
    usage: null,
  };
  if (result.reason !== null && !isCandidateReason(result.reason)) {
    fail(
      `"reason" ${JSON.stringify(result.reason)} is not aborted:* or exhausted:*`
    );
  }
  if (result.retryOf !== null && !isCandidateId(result.retryOf)) {
    fail('"retryOf" is not a candidate id');
  }
  const image = harness.optionalString('image');
  if (image !== undefined) result.harness.image = image;
  if (r.verify !== undefined) {
    const verify = read.object('verify');
    result.verify = {
      verdict: verify.oneOf('verdict', ['green', 'red', 'broken'] as const),
      attempts: verify.count('attempts'),
    };
  }
  if (r.usage !== undefined && r.usage !== null) {
    const usage = read.object('usage');
    const kept: CandidateUsage = {};
    for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
      const value = usage.optionalNumber(key);
      if (value !== undefined) kept[key] = value;
    }
    result.usage = kept;
  }
  return result;
}

/** Typed field access over one JSON object, every refusal naming its dotted path. */
class Reader {
  constructor(
    private readonly obj: Record<string, unknown>,
    private readonly fail: (why: string) => never,
    private readonly prefix = ''
  ) {}

  private bad(key: string, what: string): never {
    return this.fail(`"${this.prefix}${key}" must be ${what}`);
  }

  string(key: string): string {
    const v = this.obj[key];
    return typeof v === 'string' ? v : this.bad(key, 'a string');
  }

  optionalString(key: string): string | undefined {
    return this.obj[key] === undefined ? undefined : this.string(key);
  }

  nullableString(key: string): string | null {
    return this.obj[key] === null ? null : this.string(key);
  }

  strings(key: string): string[] {
    const v = this.obj[key];
    if (!Array.isArray(v) || !v.every(s => typeof s === 'string')) {
      return this.bad(key, 'an array of strings');
    }
    return [...(v as string[])];
  }

  boolean(key: string): boolean {
    const v = this.obj[key];
    return typeof v === 'boolean' ? v : this.bad(key, 'a boolean');
  }

  /** A non-negative integer. */
  count(key: string): number {
    const v = this.obj[key];
    return typeof v === 'number' && Number.isInteger(v) && v >= 0
      ? v
      : this.bad(key, 'a non-negative integer');
  }

  nullableCount(key: string): number | null {
    return this.obj[key] === null ? null : this.count(key);
  }

  positive(key: string): number {
    const v = this.obj[key];
    return typeof v === 'number' && Number.isInteger(v) && v > 0
      ? v
      : this.bad(key, 'a positive integer');
  }

  nullableInteger(key: string): number | null {
    const v = this.obj[key];
    if (v === null) return null;
    return typeof v === 'number' && Number.isInteger(v)
      ? v
      : this.bad(key, 'an integer or null');
  }

  optionalNumber(key: string): number | undefined {
    const v = this.obj[key];
    if (v === undefined) return undefined;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0
      ? v
      : this.bad(key, 'a non-negative number');
  }

  oneOf<T extends string>(key: string, values: readonly T[]): T {
    const v = this.obj[key];
    return values.includes(v as T)
      ? (v as T)
      : this.bad(key, `one of ${values.join(', ')}`);
  }

  object(key: string): Reader {
    const v = this.obj[key];
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return this.bad(key, 'an object');
    }
    return new Reader(
      v as Record<string, unknown>,
      this.fail,
      `${this.prefix}${key}.`
    );
  }

  array(key: string): unknown[] {
    const v = this.obj[key];
    return Array.isArray(v) ? v : this.bad(key, 'an array');
  }

  /** The object at `key[i]`. */
  at(key: string, i: number, value: unknown): Reader {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return this.bad(`${key}[${i}]`, 'an object');
    }
    return new Reader(
      value as Record<string, unknown>,
      this.fail,
      `${this.prefix}${key}[${i}].`
    );
  }
}
