import { firstCronFire } from './cron.js';
import type { Trigger } from './index.js';
import type { LoadedTrigger } from './load.js';

/**
 * **The trigger listing** (ADR-0016 section 8), one shape for `e trigger
 * list` and `GET /api/triggers`. A trigger that has never fired is invisible
 * in the run list, which is exactly the "why is my schedule not running?"
 * case - so this is where that question is answered.
 *
 * `nextFireAt` is computed from `now` and needs no `serve`; `lastFiredAt` and
 * `lastRequestId` live in `serve`'s memory since it started, so without one,
 * or after a restart, they read **unknown** - a different diagnosis from
 * never.
 */

/** A trigger's last accepted request, as `serve` remembers it. */
export interface TriggerActivity {
  lastFiredAt: string;
  lastRequestId: string;
}

/** One trigger in the listing. */
export interface TriggerListItem {
  id: string;
  /** False for a disabled trigger and for one that failed to load. */
  enabled: boolean;
  agent?: string;
  /** Its event source's kind. */
  type?: 'webhook' | 'cron';
  /** What it listens to, at a glance: `github issues.labeled`, `cron 0 3 * * * UTC`. */
  on?: string;
  /** The next scheduled fire; null for a non-cron, disabled or never-matching trigger. */
  nextFireAt: string | null;
  /** The last accepted request's time; null when unknown. */
  lastFiredAt: string | null;
  lastRequestId: string | null;
  /** Why it failed to load. */
  error?: string;
}

/** `GET /api/triggers`: the listing, and whose it is. */
export interface TriggerListingResponse {
  /** The serving Store's `.e/`, so a client can tell it is asking the right `serve`. */
  store: string;
  /** Since when `lastFiredAt` is known: `serve`'s start; null without a run queue. */
  activitySince: string | null;
  triggers: TriggerListItem[];
}

/** A one-line summary of what a trigger listens to. */
export function sourceSummary(trigger: Trigger): string {
  const on = trigger.on;
  if (on.type === 'cron') {
    return `cron ${on.expr}${on.tz ? ` ${on.tz}` : ' UTC'}`;
  }
  const action = on.action ? `.${on.action}` : '';
  return `${on.source} ${on.event}${action}`;
}

/** What `serve` knows that a listing on disk cannot. */
export interface ListingMemory {
  /** The last accepted request per trigger, since `serve` started. */
  activity?: (id: string) => TriggerActivity | undefined;
  /**
   * The scheduler's own next fire, when it has one: in the grace after a
   * scheduled time it is the fire about to happen, where a fresh computation
   * from `now` would already name the next day.
   */
  nextFireAt?: (id: string) => Date | undefined;
}

/** The listing, pure: `memory` is `serve`'s, absent when there is none. */
export function triggerListing(
  loaded: readonly LoadedTrigger[],
  now: Date,
  memory: ListingMemory = {}
): TriggerListItem[] {
  return loaded.map(entry => {
    const seen = memory.activity?.(entry.name);
    const last = {
      lastFiredAt: seen?.lastFiredAt ?? null,
      lastRequestId: seen?.lastRequestId ?? null,
    };
    const trigger = entry.trigger;
    if (!trigger) {
      return {
        id: entry.name,
        enabled: false,
        nextFireAt: null,
        ...last,
        ...(entry.error !== undefined ? { error: entry.error } : {}),
      };
    }
    const next = memory.nextFireAt?.(entry.name) ?? firstCronFire(trigger, now);
    return {
      id: entry.name,
      enabled: trigger.enabled,
      agent: trigger.agent,
      type: trigger.on.type,
      on: sourceSummary(trigger),
      nextFireAt: next ? next.toISOString() : null,
      ...last,
    };
  });
}

/** The activity a `serve`'s listing carries, keyed for {@link triggerListing}. */
export function listingActivity(
  response: TriggerListingResponse | undefined
): (id: string) => TriggerActivity | undefined {
  const byId = new Map<string, TriggerActivity>();
  for (const item of response?.triggers ?? []) {
    if (item.lastFiredAt !== null && item.lastRequestId !== null) {
      byId.set(item.id, {
        lastFiredAt: item.lastFiredAt,
        lastRequestId: item.lastRequestId,
      });
    }
  }
  return id => byId.get(id);
}
