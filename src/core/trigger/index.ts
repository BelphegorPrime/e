import type { LoopCaps } from '../store/config.js';

/**
 * The **Trigger** (ADR-0016): a named Store entity at
 * `triggers/<name>/trigger.json` binding exactly one event source to exactly
 * one Agent and one prompt template - the only thing that may start a Run
 * without a human. The directory name is the trigger's id and the prefix of
 * its dedup key, so it is stable and filename-safe for free.
 *
 * Parsing is where the guarantees live: everything a hostile payload can reach
 * is either pattern-validated or kept out of the prompt entirely.
 */

/** Forges whose webhook vocabulary `e` speaks. GitHub only in v1. */
export const WEBHOOK_SOURCES = ['github'] as const;
export type WebhookSource = (typeof WEBHOOK_SOURCES)[number];

/**
 * What a trigger listens to. A discriminated union, and a trigger carries
 * exactly one: two sources would make `<trigger id>:<event dedup value>` draw
 * its halves from two different vocabularies.
 */
export type TriggerOn =
  | {
      type: 'webhook';
      /** The forge whose headers and signature scheme the edge reads. */
      source: WebhookSource;
      /**
       * The provider's own event name (`X-GitHub-Event`). `e` ships no event
       * catalogue: a mapping table for four forges goes stale on someone
       * else's release schedule. The cost is that a typo never fires.
       */
      event: string;
      /** The provider's own `payload.action`, when the event has one. */
      action?: string;
      /**
       * Dotted payload paths to expected values, all ANDed; an array value is
       * OR. Exact match only - the payload is attacker-controlled, and
       * anything that evaluates expressions evaluates them against a
       * stranger's data.
       */
      match?: Record<string, string | string[]>;
    }
  | {
      type: 'cron';
      /** 5-field cron, or an `@`-alias. */
      expr: string;
      /** IANA zone; the scheduler defaults to UTC, never the host's zone. */
      tz?: string;
    };

/** A parsed, valid trigger. */
export interface Trigger {
  /** The directory name: the trigger's id and its dedup-key prefix. */
  name: string;
  /** `false` switches it off in place, keeping its identity. */
  enabled: boolean;
  /** The Agent this trigger runs; required, because a trigger cannot retype. */
  agent: string;
  /** A checkout this trigger targets; only meaningful in a home Store. */
  repo?: string;
  /** The branch a run cuts from; the repository's default branch when absent. */
  base?: string;
  /** The prompt template; only whitelisted identifiers interpolate into it. */
  prompt: string;
  /** A payload path that coarsens the dedup key from one delivery to one subject. */
  dedup?: string;
  /** Whether a fire is dropped while this trigger already owns a live run. */
  overlap: 'skip' | 'allow';
  /** A field-wise override of the Store's `loop` block; the only one allowed. */
  loop?: Partial<LoopCaps>;
  /** The one event source. */
  on: TriggerOn;
}

/**
 * What the Store around a trigger knows that the file itself cannot: which
 * agents exist, and whether the Store sits inside the repository it targets.
 * Both are checked at load so a trigger that cannot possibly run says so when
 * the Store is read rather than when it fires.
 */
export interface TriggerContext {
  /** Agent and harness names this Store can resolve; unchecked when absent. */
  knownAgents?: readonly string[];
  /**
   * `true` when the Store was found inside a repository, which is then the
   * target and `repo` is ignored. `false` for the home Store, where a trigger
   * must name its `repo`. Unchecked when absent.
   */
  repoLocal?: boolean;
}

/** Rejects `raw` with a message naming the trigger and the file it came from. */
function invalid(name: string, where: string, why: string): never {
  throw new Error(`Invalid trigger "${name}" at ${where}: ${why}`);
}

/**
 * Parses one `trigger.json` body. Throws on anything it cannot accept - the
 * loader turns that into one invalid trigger rather than a dead Store.
 */
export function parseTrigger(
  raw: unknown,
  name: string,
  where: string,
  context: TriggerContext = {}
): Trigger {
  const p = (raw ?? {}) as Record<string, unknown>;

  if (typeof p.agent !== 'string' || p.agent === '') {
    // No fallback to `defaultHarness`: that default is a convenience for a
    // human who sees what happened and can retype, and editing config.json
    // must not silently change who runs tonight.
    invalid(name, where, '"agent" is required');
  }
  if (typeof p.prompt !== 'string' || p.prompt === '') {
    invalid(name, where, '"prompt" is required');
  }
  // The gate belongs to the repository and the limits to the machine. A
  // trigger carrying its own gate can carry a weaker one, and
  // `"verify": {"command": "true"}` defeats it without anybody touching a test.
  if (p.verify !== undefined) {
    invalid(
      name,
      where,
      '"verify" belongs to the repository, not to a trigger'
    );
  }
  if (p.resources !== undefined) {
    invalid(name, where, '"resources" is Store-wide and cannot be overridden');
  }

  // Both of these are load-time errors on purpose: a trigger that cannot run
  // should say so when the Store is read, not at three in the morning.
  if (context.knownAgents && !context.knownAgents.includes(p.agent)) {
    invalid(
      name,
      where,
      `unknown agent "${p.agent}"; known: ${context.knownAgents.join(', ')}`
    );
  }
  if (context.repoLocal === false && typeof p.repo !== 'string') {
    invalid(
      name,
      where,
      'a trigger in a home store needs "repo": a run needs a git repository for its worktree and branch'
    );
  }

  const trigger: Trigger = {
    name,
    enabled: p.enabled !== false,
    agent: p.agent,
    prompt: p.prompt,
    overlap: p.overlap === 'allow' ? 'allow' : 'skip',
    on: parseOn(p.on, name, where),
  };
  if (typeof p.repo === 'string' && p.repo !== '') trigger.repo = p.repo;
  if (typeof p.base === 'string' && p.base !== '') trigger.base = p.base;
  if (typeof p.dedup === 'string' && p.dedup !== '') trigger.dedup = p.dedup;
  const loop = parseLoopOverride(p.loop, name, where);
  if (loop) trigger.loop = loop;
  return trigger;
}

/** The one event source, as its own union arm. */
function parseOn(raw: unknown, name: string, where: string): TriggerOn {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    invalid(name, where, '"on" is required');
  }
  const on = raw as Record<string, unknown>;

  if (on.type === 'cron') {
    if (typeof on.expr !== 'string' || on.expr === '') {
      invalid(name, where, 'a cron source needs an "expr"');
    }
    const source: TriggerOn = { type: 'cron', expr: on.expr };
    if (typeof on.tz === 'string' && on.tz !== '') source.tz = on.tz;
    return source;
  }

  if (on.type === 'webhook') {
    if (!WEBHOOK_SOURCES.includes(on.source as WebhookSource)) {
      invalid(
        name,
        where,
        `unknown webhook source "${String(on.source)}"; known: ${WEBHOOK_SOURCES.join(', ')}`
      );
    }
    if (typeof on.event !== 'string' || on.event === '') {
      invalid(name, where, 'a webhook source needs an "event"');
    }
    const source: TriggerOn = {
      type: 'webhook',
      source: on.source as WebhookSource,
      event: on.event,
    };
    if (typeof on.action === 'string' && on.action !== '') {
      source.action = on.action;
    }
    const match = parseMatch(on.match, name, where);
    if (match) source.match = match;
    return source;
  }

  invalid(name, where, `unknown event source "${String(on.type)}"`);
}

/** `match`: dotted paths to a string or a list of strings, and nothing else. */
function parseMatch(
  raw: unknown,
  name: string,
  where: string
): Record<string, string | string[]> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    invalid(name, where, '"match" must be an object of payload paths');
  }
  const match: Record<string, string | string[]> = {};
  for (const [path, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      match[path] = value;
    } else if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(v => typeof v === 'string')
    ) {
      match[path] = value as string[];
    } else {
      invalid(
        name,
        where,
        `"match.${path}" must be a string or a non-empty array of strings`
      );
    }
  }
  return match;
}

/** The `loop` override: the four known caps, each a positive integer. */
function parseLoopOverride(
  raw: unknown,
  name: string,
  where: string
): Partial<LoopCaps> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    invalid(name, where, '"loop" must be an object');
  }
  const keys = [
    'maxIterations',
    'iterationTimeoutMs',
    'totalTimeoutMs',
    'softTotalTimeoutMs',
  ] as const;
  const loop: Partial<LoopCaps> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!keys.includes(key as (typeof keys)[number])) {
      invalid(name, where, `unknown loop cap "${key}"`);
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      invalid(name, where, `"loop.${key}" must be a positive integer`);
    }
    loop[key as (typeof keys)[number]] = value;
  }
  return Object.keys(loop).length > 0 ? loop : undefined;
}
