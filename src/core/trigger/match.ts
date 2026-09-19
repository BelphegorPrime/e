import type { TriggerOn } from './index.js';

/**
 * Whether a delivery is the one a trigger asked for (ADR-0016). Exact match
 * only, on values read by dotted path: the payload is attacker-controlled, and
 * anything that evaluates expressions evaluates them against a stranger's
 * data. Regex over attacker input is where ReDoS lives; an expression language
 * would be a new dependency and an evaluator on the same untrusted bytes.
 */

/** A delivery, as the edge hands it on: the provider's event name and its body. */
export interface TriggerEvent {
  /** The provider's own event name (`X-GitHub-Event`). */
  name: string;
  /** The delivery body, exactly as it arrived. */
  payload: unknown;
}

/**
 * Reads a dotted path out of a payload. Anything missing along the way, or a
 * value that is not a plain object where one is needed, reads as `undefined` -
 * a payload shape we did not expect must not throw, it must just not fire.
 */
export function readPath(payload: unknown, path: string): unknown {
  let value = payload;
  for (const segment of path.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

/** A payload value compares as the text it is written as, or not at all. */
function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

/** True when this trigger's source is exactly what the delivery carries. */
export function matchesEvent(on: TriggerOn, event: TriggerEvent): boolean {
  // A clock has no deliveries; the scheduler fires it, not the edge.
  if (on.type !== 'webhook') return false;
  if (on.event !== event.name) return false;
  if (on.action !== undefined) {
    if (asText(readPath(event.payload, 'action')) !== on.action) return false;
  }
  for (const [path, expected] of Object.entries(on.match ?? {})) {
    const actual = asText(readPath(event.payload, path));
    if (actual === undefined) return false;
    const ok = Array.isArray(expected)
      ? expected.includes(actual)
      : expected === actual;
    if (!ok) return false;
  }
  return true;
}
