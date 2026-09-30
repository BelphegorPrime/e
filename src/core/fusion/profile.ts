import { isAgentName, isRemoteAgent, type Agent } from '../agent/agent.js';

/**
 * The **Fusion profile** (ADR-0019 section 2): a named Store entity at
 * `fusions/<name>/fusion.json` declaring which Agents are the candidates of a
 * fusion, which Agent synthesizes, the strategy, and the fusion's own limits.
 * The directory name is the profile's id.
 *
 * A profile references Agents **by name, never by value**: no provider, model,
 * harness or key is ever copied here, so the secrets mechanisms that already
 * reach an Agent (ADR-0006, ADR-0016) are the only ones a fusion uses.
 *
 * Parsing is where "fail before anything is built" is kept: everything a
 * profile could get wrong is refused here, before an image, a worktree or a
 * container exists.
 */

/**
 * How a fusion combines its candidates. A closed enum: every other strategy
 * (select-only, first-k, rounds) needs an ADR of its own, and until one
 * exists no Store can switch on a behaviour nobody designed.
 */
export const FUSION_STRATEGIES = ['parallel-synthesize'] as const;
export type FusionStrategy = (typeof FUSION_STRATEGIES)[number];

/**
 * A profile's id as it may reach the synthesis PR's fusion block, which is
 * built from identifiers only (ADR-0016 section 9's rule, ADR-0019 section 8).
 */
export const FUSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The fusion's own deadlines (ADR-0019 section 9); the Run's caps stay the
 * Store's. `candidatesMs` bounds the fan-out phase, whose outstanding
 * candidates are canceled when it fires; `totalMs` the whole fusion, hard.
 */
export const FUSION_TIMEOUT_KEYS = ['candidatesMs', 'totalMs'] as const;
export type FusionTimeouts = Partial<
  Record<(typeof FUSION_TIMEOUT_KEYS)[number], number>
>;

/**
 * The longest deadline a timer can hold: Node's `setTimeout` fires a larger
 * delay after 1 ms, so a generous typo would cancel a fusion at once.
 */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * The fusion's retries of a failed candidate (ADR-0019 section 9): a retry is
 * a new Candidate run of the same Agent, never a rerun inside a Run, and only
 * for a failure classified retryable (`classifyAttempt`). `maxAttempts`
 * counts the first attempt, so 1 is no retry; the delay before attempt n+1
 * is `min(maxBackoffMs, backoffMs x 2^(n-1))`, half of it fixed and half
 * jitter. A retry never extends `candidatesMs`.
 */
export const FUSION_RETRY_KEYS = [
  'maxAttempts',
  'backoffMs',
  'maxBackoffMs',
] as const;
export interface FusionRetry {
  /** Attempts per candidate, the first included: 1 means no retry. */
  maxAttempts: number;
  /** The backoff before the first retry, doubled for each one after. */
  backoffMs: number;
  /** The most any one backoff grows to. */
  maxBackoffMs: number;
}

/** Retries when a profile declares none: off. */
export const DEFAULT_FUSION_RETRY: FusionRetry = {
  maxAttempts: 1,
  backoffMs: 30 * 1000,
  maxBackoffMs: 5 * 60 * 1000,
};

/**
 * The most attempts a candidate may get: a provider that fails five times in
 * a row is down, and more attempts only spend the fan-out's deadline.
 */
export const MAX_FUSION_ATTEMPTS = 5;

/** A parsed, valid profile, defaults resolved. */
export interface FusionProfile {
  /** The directory name: the profile's id. */
  name: string;
  /** Two or more Agent names, in launch order; repeats allowed. */
  candidates: string[];
  /** The Agent whose run combines the candidates into the fusion's result. */
  synthesizer: string;
  strategy: FusionStrategy;
  /** Candidates in flight at once. */
  maxConcurrency: number;
  /** Usable candidates the synthesis needs; fewer and the fusion fails without one. */
  minUsable: number;
  /** Absent when neither deadline is declared; their defaults are derived at run time. */
  timeouts?: FusionTimeouts;
  /** Absent when not declared: no retries ({@link DEFAULT_FUSION_RETRY}). Resolved when present. */
  retry?: FusionRetry;
}

/**
 * What the Store around a profile knows that the file cannot: which Agents
 * exist, and which of them are Remote agents. Checked at load, so a profile
 * that cannot possibly run says so when the Store is read.
 */
export interface FusionContext {
  /**
   * Every name this Store resolves, to its Agent or to why it does not
   * resolve; the Agents are unchecked when absent. Resolved Agents rather
   * than names, so what a profile passed is what a spawn will run.
   */
  agents?: ReadonlyMap<string, Agent | Error>;
}

/** The keys a `fusion.json` may carry; anything else is refused. */
const KNOWN_KEYS = new Set([
  'name',
  'candidates',
  'synthesizer',
  'strategy',
  'maxConcurrency',
  'minUsable',
  'timeouts',
  'retry',
]);

/**
 * Keys that belong in an Agent. Refused with their own message, because
 * someone who writes one is trying to configure a model here, and "unknown
 * key" would not tell them where it goes instead.
 */
const AGENT_KEYS = new Set([
  'provider',
  'harness',
  'model',
  'baseUrl',
  'baseUrlEnv',
  'apiKeyEnv',
  'env',
  'skills',
]);

/** The default fan-out: every candidate at once, but never more than three. */
const DEFAULT_MAX_CONCURRENCY = 3;

/** Rejects a profile with a message naming it and the file it came from. */
function invalid(name: string, where: string, why: string): never {
  throw new Error(`Invalid fusion profile "${name}" at ${where}: ${why}`);
}

/**
 * Parses one `fusion.json` body. Throws on anything it cannot accept; the
 * loader turns that into one invalid profile rather than a dead Store.
 */
export function parseFusionProfile(
  raw: unknown,
  name: string,
  where: string,
  context: FusionContext = {}
): FusionProfile {
  if (!FUSION_NAME_PATTERN.test(name)) {
    invalid(
      name,
      where,
      `the directory name must match ${FUSION_NAME_PATTERN}: it is the profile's id, written into the synthesis PR`
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    invalid(name, where, 'must be a JSON object');
  }
  const p = raw as Record<string, unknown>;

  for (const key of Object.keys(p)) {
    if (AGENT_KEYS.has(key)) {
      invalid(
        name,
        where,
        `"${key}" belongs in an Agent; a profile references Agents by name`
      );
    }
    if (!KNOWN_KEYS.has(key)) invalid(name, where, `unknown key "${key}"`);
  }
  // Allowed because `agent.json` carries one too, and #173 sketched it; a
  // second, different identity is the drift it would invite.
  if (p.name !== undefined && p.name !== name) {
    invalid(
      name,
      where,
      `declares the name ${JSON.stringify(p.name)}; the directory name is the profile's id`
    );
  }

  const candidates = parseCandidates(p.candidates, name, where);
  if (p.synthesizer === undefined || p.synthesizer === '') {
    invalid(name, where, '"synthesizer" is required');
  }
  if (typeof p.synthesizer !== 'string' || !isAgentName(p.synthesizer)) {
    invalid(name, where, `"synthesizer" is not an Agent name`);
  }
  checkAgent('candidate', candidates, context, name, where);
  checkAgent('synthesizer', [p.synthesizer], context, name, where);

  const strategy = p.strategy ?? 'parallel-synthesize';
  if (!FUSION_STRATEGIES.includes(strategy as FusionStrategy)) {
    invalid(
      name,
      where,
      `unknown strategy ${JSON.stringify(strategy)}; known: ${FUSION_STRATEGIES.join(', ')}`
    );
  }

  const maxConcurrency =
    p.maxConcurrency === undefined
      ? Math.min(candidates.length, DEFAULT_MAX_CONCURRENCY)
      : positiveInteger(p.maxConcurrency, '"maxConcurrency"', name, where);
  const minUsable =
    p.minUsable === undefined
      ? 1
      : positiveInteger(p.minUsable, '"minUsable"', name, where);
  if (minUsable > candidates.length) {
    invalid(
      name,
      where,
      `"minUsable" ${minUsable} exceeds the ${candidates.length} candidates: the fusion could never synthesize`
    );
  }

  const profile: FusionProfile = {
    name,
    candidates,
    synthesizer: p.synthesizer,
    strategy: strategy as FusionStrategy,
    maxConcurrency,
    minUsable,
  };
  const timeouts = parseTimeouts(p.timeouts, name, where);
  if (timeouts) profile.timeouts = timeouts;
  const retry = parseRetry(p.retry, name, where);
  if (retry) profile.retry = retry;
  return profile;
}

/** `candidates`: two or more Agent names, in launch order. */
function parseCandidates(raw: unknown, name: string, where: string): string[] {
  if (raw === undefined) invalid(name, where, '"candidates" is required');
  if (!Array.isArray(raw)) {
    invalid(name, where, '"candidates" must be an array of Agent names');
  }
  // One candidate is a single-agent run with a synthesizer bolted on: a
  // fusion under a misleading name.
  if (raw.length < 2) {
    invalid(name, where, 'a fusion needs at least two candidates');
  }
  raw.forEach((candidate: unknown, index) => {
    if (typeof candidate !== 'string' || !isAgentName(candidate)) {
      invalid(name, where, `candidates[${index}] is not an Agent name`);
    }
  });
  return [...(raw as string[])];
}

/**
 * Every Agent a profile names must resolve, and to a harness agent: a Remote
 * agent (ADR-0015) has no branch and no diff, so it could hand a synthesizer
 * nothing and a synthesis could deliver nothing.
 */
function checkAgent(
  role: 'candidate' | 'synthesizer',
  agents: readonly string[],
  context: FusionContext,
  name: string,
  where: string
): void {
  const known = context.agents;
  if (!known) return;
  for (const agent of agents) {
    const resolved = known.get(agent);
    if (resolved === undefined) {
      const names = [...known].filter(
        ([, entry]) => !(entry instanceof Error) && !isRemoteAgent(entry)
      );
      invalid(
        name,
        where,
        `${role} "${agent}" is not an Agent in this Store; known: ${names.map(([n]) => n).join(', ')}`
      );
    }
    if (resolved instanceof Error) {
      invalid(
        name,
        where,
        `${role} "${agent}" does not resolve: ${resolved.message}`
      );
    }
    if (isRemoteAgent(resolved)) {
      invalid(
        name,
        where,
        `${role} "${agent}" is a Remote agent; a fusion needs harness agents, which leave a branch`
      );
    }
  }
}

/** A positive integer, or a refusal naming the field. */
function positiveInteger(
  value: unknown,
  field: string,
  name: string,
  where: string
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    invalid(name, where, `${field} must be a positive integer`);
  }
  return value;
}

/** `timeouts`: the two known deadlines, the fan-out inside the whole. */
function parseTimeouts(
  raw: unknown,
  name: string,
  where: string
): FusionTimeouts | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    invalid(name, where, '"timeouts" must be an object');
  }
  type Key = (typeof FUSION_TIMEOUT_KEYS)[number];
  const timeouts: FusionTimeouts = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!FUSION_TIMEOUT_KEYS.includes(key as Key)) {
      invalid(name, where, `unknown timeout "${key}"`);
    }
    const ms = positiveInteger(value, `"timeouts.${key}"`, name, where);
    if (ms > MAX_TIMEOUT_MS) {
      invalid(
        name,
        where,
        `"timeouts.${key}" must be at most ${MAX_TIMEOUT_MS} (about 24.8 days)`
      );
    }
    timeouts[key as Key] = ms;
  }
  // A fan-out deadline at or past the whole would never fire: the total
  // would always cancel first, and the declaration would be a lie.
  if (
    timeouts.candidatesMs !== undefined &&
    timeouts.totalMs !== undefined &&
    timeouts.candidatesMs >= timeouts.totalMs
  ) {
    invalid(
      name,
      where,
      '"timeouts.candidatesMs" must be less than "timeouts.totalMs"'
    );
  }
  return Object.keys(timeouts).length > 0 ? timeouts : undefined;
}

/**
 * `retry`: the attempts per candidate and the backoff between them, resolved
 * over {@link DEFAULT_FUSION_RETRY}. An undeclared `maxBackoffMs` grows with
 * a declared `backoffMs`, so declaring one never makes the other invalid.
 */
function parseRetry(
  raw: unknown,
  name: string,
  where: string
): FusionRetry | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    invalid(name, where, '"retry" must be an object');
  }
  type Key = (typeof FUSION_RETRY_KEYS)[number];
  const declared: Partial<FusionRetry> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!FUSION_RETRY_KEYS.includes(key as Key)) {
      invalid(name, where, `unknown retry key "${key}"`);
    }
    const n = positiveInteger(value, `"retry.${key}"`, name, where);
    if (n > MAX_TIMEOUT_MS) {
      invalid(
        name,
        where,
        `"retry.${key}" must be at most ${MAX_TIMEOUT_MS} (about 24.8 days)`
      );
    }
    declared[key as Key] = n;
  }
  const maxAttempts = declared.maxAttempts ?? DEFAULT_FUSION_RETRY.maxAttempts;
  if (maxAttempts > MAX_FUSION_ATTEMPTS) {
    invalid(
      name,
      where,
      `"retry.maxAttempts" must be at most ${MAX_FUSION_ATTEMPTS}`
    );
  }
  const backoffMs = declared.backoffMs ?? DEFAULT_FUSION_RETRY.backoffMs;
  const maxBackoffMs =
    declared.maxBackoffMs ??
    Math.max(DEFAULT_FUSION_RETRY.maxBackoffMs, backoffMs);
  if (maxBackoffMs < backoffMs) {
    invalid(
      name,
      where,
      '"retry.maxBackoffMs" must not be less than "retry.backoffMs"'
    );
  }
  return { maxAttempts, backoffMs, maxBackoffMs };
}
