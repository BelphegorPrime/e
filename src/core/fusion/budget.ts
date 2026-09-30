import { DEFAULT_LOOP_CAPS, type LoopCaps } from '../store/config.js';
import {
  DEFAULT_FUSION_RETRY,
  type FusionProfile,
  type FusionRetry,
} from './profile.js';
import type { CandidateResult } from './result.js';

/**
 * **A fusion's budgets** (ADR-0019 section 9), as pure functions the
 * coordinator applies: the two deadlines a fusion owns, the backoff between
 * a candidate's attempts, and which failed attempts deserve another.
 *
 * The Run's caps are untouched: a candidate and the synthesis each get the
 * Store's `loop` like any run. These bound only the phases the fusion owns,
 * so a fusion's worst case is readable off `config.json` and `fusion.json`.
 */

/** The margin each derived deadline adds for builds and pushes. */
export const FUSION_DEADLINE_MARGIN_MS = 15 * 60 * 1000;

/** A fusion's two deadlines, relative to its start. */
export interface FusionDeadlines {
  /** The fan-out: outstanding candidates are stopped as `timed-out` when it passes. */
  candidatesMs: number;
  /** The whole fusion, hard: everything outstanding is stopped and the fusion is `exhausted`. */
  totalMs: number;
}

/**
 * The deadlines of a profile under the Store's `loop` caps. A declared value
 * is taken as it stands; an undeclared one is derived so that a Run's own
 * caps fire first: with `rounds = ceil(candidates / maxConcurrency)`,
 * `candidatesMs = rounds x loop.totalTimeoutMs + 15 min` and
 * `totalMs = candidatesMs + loop.totalTimeoutMs + 15 min`. A declared
 * `totalMs` below the derived `candidatesMs` bounds the fan-out too: the
 * whole fusion's deadline is checked first, and it is hard.
 */
export function fusionDeadlines(
  profile: Pick<FusionProfile, 'candidates' | 'maxConcurrency' | 'timeouts'>,
  loop: Pick<LoopCaps, 'totalTimeoutMs'> = DEFAULT_LOOP_CAPS
): FusionDeadlines {
  const rounds = Math.ceil(profile.candidates.length / profile.maxConcurrency);
  const candidatesMs =
    profile.timeouts?.candidatesMs ??
    rounds * loop.totalTimeoutMs + FUSION_DEADLINE_MARGIN_MS;
  const totalMs =
    profile.timeouts?.totalMs ??
    candidatesMs + loop.totalTimeoutMs + FUSION_DEADLINE_MARGIN_MS;
  return { candidatesMs, totalMs };
}

/** The retry policy a profile runs with: its declaration, or none. */
export function retryPolicy(
  profile: Pick<FusionProfile, 'retry'>
): FusionRetry {
  return profile.retry ?? DEFAULT_FUSION_RETRY;
}

/**
 * How long to wait before retrying the attempt numbered `failedAttempt` (1
 * for the first): exponential, capped, with "equal jitter" - half the delay
 * fixed, half drawn from `random` (a `Math.random`-shaped source, injected so
 * tests are deterministic). The fixed half keeps two candidates of one
 * provider that failed together from retrying at once; the random half keeps
 * several fusions from retrying in step.
 */
export function retryDelayMs(
  policy: Pick<FusionRetry, 'backoffMs' | 'maxBackoffMs'>,
  failedAttempt: number,
  random: () => number = Math.random
): number {
  const exponent = Math.max(0, failedAttempt - 1);
  const capped = Math.min(
    policy.maxBackoffMs,
    policy.backoffMs * 2 ** Math.min(exponent, 30)
  );
  const draw = Math.min(1, Math.max(0, random()));
  return Math.round(capped / 2 + draw * (capped / 2));
}

/**
 * Whether a settled attempt deserves another (ADR-0019 section 9): the
 * explicit seam a Store's policy can later replace, deterministic over the
 * envelope alone.
 */
export type AttemptClass = 'retryable' | 'terminal';
export type RetryClassifier = (result: CandidateResult) => AttemptClass;

/**
 * The reasons a failed run may carry and still be retried: the harness
 * process itself died (a provider outage, a rate limit, a crash), before any
 * commit. Everything else a run reports as a reason - its iterations or
 * wall clock exhausted, an OOM that would recur under the same caps, a
 * broken check, a branch the host could not read - is terminal.
 */
export const RETRYABLE_REASONS: readonly string[] = ['aborted:harness-exit'];

/**
 * The conservative default: an attempt is retryable only when it `failed`,
 * left **no commits** beyond the base, never reached the repository's check
 * (a gate verdict is an answer, not an accident), and ended either without
 * a reason - it could not launch, its build failed, the process died before
 * reporting - or with one of {@link RETRYABLE_REASONS}. A candidate that
 * produced commits is never retried, nor one the fusion itself stopped.
 */
export function classifyAttempt(result: CandidateResult): AttemptClass {
  if (result.outcome !== 'failed') return 'terminal';
  if (result.tip !== null) return 'terminal';
  if (result.verify !== undefined) return 'terminal';
  if (result.reason !== null && !RETRYABLE_REASONS.includes(result.reason)) {
    return 'terminal';
  }
  return 'retryable';
}
