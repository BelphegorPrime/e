import { Cron } from 'croner';
import type { Trigger } from './index.js';
import { overlapDrop, triggerRequest, type TriggerFire } from './fire.js';

/**
 * **Cron** (ADR-0016 section 8): a cron trigger is an ordinary trigger whose
 * event source is the clock. `croner` is the next-run calculator **only** -
 * DST-correct "next occurrence in Europe/Berlin" is genuinely hard to write
 * twice - and the scheduling loop stays ours, one step in the `serve` tick.
 *
 * - **5 fields plus the `@`-aliases**, no seconds field: it would promise a
 *   precision the 30 s tick cannot honour.
 * - **`tz` defaults to UTC**, not the host zone, which a detached `serve`
 *   inherits from whichever shell started it.
 * - **The spring gap has no matching instant.** croner moves an occurrence
 *   in the gap to the first valid wall-clock time after it; a candidate the
 *   pattern does not itself match is skipped here. The autumn hour is not
 *   replayed: the next fire always moves forward from the last.
 */

/** The zone a cron trigger without `tz` runs in. */
export const CRON_DEFAULT_TZ = 'UTC';

/**
 * How late a due fire may still be noticed and fired. The tick runs every 30
 * s, so a fire is normally seen up to 30 s late; past twice that the process
 * was not ticking (a suspend, a stalled loop) and the fire is **discarded,
 * never caught up**.
 */
export const CRON_GRACE_MS = 60 * 1000;

/** What a cron schedule needs: the `on` block of a cron trigger. */
export interface CronSpec {
  expr: string;
  tz?: string;
}

/** Candidates croner may offer before one the pattern really matches. */
const MAX_SHIFTED_CANDIDATES = 8;

function schedule(spec: CronSpec): Cron {
  // No callback: croner only computes, it never starts a timer of its own.
  return new Cron(spec.expr, {
    timezone: spec.tz ?? CRON_DEFAULT_TZ,
    mode: '5-part',
  });
}

/**
 * Why `expr` in `tz` is not a schedule `e` runs, or undefined when it is.
 * Validated once at load, so a bad expression disables its one trigger
 * rather than failing at the first tick.
 */
export function cronExprError(
  expr: string,
  tz: string | undefined
): string | undefined {
  try {
    // A bad zone only surfaces once a date is converted into it.
    schedule({ expr, ...(tz !== undefined ? { tz } : {}) }).nextRun();
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The first fire strictly after `from`, or undefined for a schedule that
 * never matches (`0 0 30 2 *`). Stateless: a restart, a reload or a clock
 * jump computes it from `now` and nothing is ever retroactive.
 */
export function nextCronFire(spec: CronSpec, from: Date): Date | undefined {
  const cron = schedule(spec);
  let candidate = cron.nextRun(from);
  for (let i = 0; candidate && i < MAX_SHIFTED_CANDIDATES; i++) {
    if (cron.match(candidate)) return candidate;
    candidate = cron.nextRun(candidate);
  }
  return undefined;
}

/**
 * A trigger's first fire after `now`, as a restart, a reload or a listing
 * sees it: none for a disabled trigger, a webhook one, or an expression that
 * matches no date.
 */
export function firstCronFire(trigger: Trigger, now: Date): Date | undefined {
  return trigger.enabled && trigger.on.type === 'cron'
    ? nextCronFire(trigger.on, now)
    : undefined;
}

/**
 * The `{{tick}}` value and a cron trigger's dedup value: the **scheduled**
 * time, minute-granular, UTC, compact (`20260918T0300Z`). Scheduled and not
 * actual, because the tick may notice a due fire up to 30 s late and the key
 * must not move with it. A one-shot tick is spelled alike.
 */
export function tickStamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
}

/**
 * A cron trigger firing for the time it was scheduled at: `nightly:<tick>`,
 * the event `cron:tick:<tick>`. No payload, so only `{{tick}}` and
 * `{{trigger}}` interpolate, both host-generated.
 */
export function cronFire(
  trigger: Trigger,
  scheduled: Date,
  live: ReadonlySet<string>
): TriggerFire {
  const overlap = overlapDrop(trigger, live);
  if (overlap !== undefined) return { trigger: trigger.name, dropped: overlap };
  const tick = tickStamp(scheduled);
  return triggerRequest(trigger, {
    dedupValue: tick,
    event: { source: 'cron', event: 'tick', id: tick },
    tick,
  });
}

/** What the tick does about a scheduled fire. */
export type CronDue = 'wait' | 'fire' | 'missed';

/** Whether the fire scheduled at `scheduled` is due at `now`. */
export function cronDue(scheduled: Date, now: Date): CronDue {
  const late = now.getTime() - scheduled.getTime();
  if (late < 0) return 'wait';
  return late <= CRON_GRACE_MS ? 'fire' : 'missed';
}
