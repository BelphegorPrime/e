import type { Trigger } from './index.js';
import { isWebhookSource } from './index.js';
import { triggerRequest, type TriggerFire } from './fire.js';
import type { ProvenanceEvent } from './provenance.js';
import { fireWebhook } from './webhook.js';

/**
 * **Redrive** (ADR-0016 section 6): a dead request back into the queue, by a
 * human, as a **fresh acceptance**. It reuses the event and its payload and
 * nothing else: agent, base, prompt template, caps and the `match` filters
 * come from the declaration as it is now, so "fix the trigger, then redrive"
 * works, and a faithful replay cannot reproduce the bug that killed it.
 */

/** What a dead request keeps of the event it was accepted for. */
export interface DeadEvent {
  event: ProvenanceEvent;
  payload?: unknown;
}

/**
 * The request the current declaration makes of a dead event, or why it
 * makes none: disabled, another kind of source, or a `match` that no longer
 * agrees. `overlap` is not asked - a human is starting this one.
 */
export function redriveFire(trigger: Trigger, dead: DeadEvent): TriggerFire {
  const refuse = (dropped: string): TriggerFire => ({
    trigger: trigger.name,
    dropped,
  });
  if (!trigger.enabled) return refuse(`trigger "${trigger.name}" is disabled`);
  const { event } = dead;
  const on = trigger.on;
  if (on.type === 'cron') {
    if (event.source !== 'cron') {
      return refuse(
        `trigger "${trigger.name}" is a cron trigger now, and this request came from ${event.source}`
      );
    }
    // The tick it was scheduled for stays its identity and its {{tick}}.
    return triggerRequest(trigger, {
      dedupValue: event.id,
      event,
      tick: event.id,
    });
  }
  if (!isWebhookSource(event.source) || event.source !== on.source) {
    return refuse(
      `trigger "${trigger.name}" listens to ${on.source} now, and this request came from ${event.source}`
    );
  }
  const [fire] = fireWebhook(
    [trigger],
    {
      source: event.source,
      name: event.event,
      id: event.id,
      payload: dead.payload,
    },
    { live: new Set(), fallbackId: event.id }
  );
  return (
    fire ??
    refuse(
      `trigger "${trigger.name}" no longer matches this ${event.event} event (its on/match changed)`
    )
  );
}
