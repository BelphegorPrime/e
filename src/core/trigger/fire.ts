import type { Trigger } from './index.js';
import { renderTriggerPrompt } from './prompt.js';
import type { ProvenanceEvent } from './provenance.js';
import type { LoopCaps } from '../store/config.js';

/**
 * **A trigger firing** (ADR-0016 sections 5 and 6): what every event source
 * - a webhook delivery, a cron tick - turns a matching trigger into. Either a
 * request for the queue, keyed `<trigger id>:<dedup value>`, or the reason
 * this event starts nothing for this trigger. The source decides the dedup
 * value and the event; the rules shared by all sources live here.
 */

/** What a firing trigger asks the queue for: the queue assigns the rest. */
export interface TriggerRequest {
  key: string;
  trigger: string;
  agent: string;
  prompt: string;
  base?: string;
  loop?: Partial<LoopCaps>;
  /** The raw event: the queue's acceptance validates its id. */
  event: ProvenanceEvent;
  /** The delivery body; a tick has none. */
  payload?: unknown;
}

/** One firing trigger: its request, or why the event drops for it. */
export type TriggerFire =
  | { trigger: string; request: TriggerRequest }
  | { trigger: string; dropped: string };

/**
 * `overlap: "skip"` (the default, any trigger type): while this trigger owns
 * a run that has not ended, the event is dropped - two runs off the same base
 * race each other into two PRs. Separate from dedup, which is checked against
 * pending requests only and deliberately lets a forge redelivery re-run.
 */
export function overlapDrop(
  trigger: Trigger,
  live: ReadonlySet<string>
): string | undefined {
  return trigger.overlap === 'skip' && live.has(trigger.name)
    ? `${trigger.name} already owns a live run (overlap: skip)`
    : undefined;
}

/** What a source hands {@link triggerRequest}. */
export interface FireEvent {
  /** The key's second half: the source's identity, or a coarser subject. */
  dedupValue: string;
  event: ProvenanceEvent;
  payload?: unknown;
  /** The scheduled time, for `{{tick}}`. */
  tick?: string;
}

/**
 * Renders the prompt and `base` through the whitelist and builds the request.
 * A value that fails its pattern drops the event, never coerced.
 */
export function triggerRequest(trigger: Trigger, fire: FireEvent): TriggerFire {
  const drop = (dropped: string): TriggerFire => ({
    trigger: trigger.name,
    dropped,
  });
  const context = {
    payload: fire.payload,
    trigger: trigger.name,
    ...(fire.tick !== undefined ? { tick: fire.tick } : {}),
  };
  const prompt = renderTriggerPrompt(trigger.prompt, context);
  if (!prompt.ok) return drop(`"prompt": ${prompt.reason}`);
  let base: string | undefined;
  if (trigger.base !== undefined) {
    const result = renderTriggerPrompt(trigger.base, context);
    if (!result.ok) return drop(`"base": ${result.reason}`);
    base = result.text;
  }
  return {
    trigger: trigger.name,
    request: {
      key: `${trigger.name}:${fire.dedupValue}`,
      trigger: trigger.name,
      agent: trigger.agent,
      prompt: prompt.text,
      ...(base !== undefined ? { base } : {}),
      ...(trigger.loop ? { loop: trigger.loop } : {}),
      event: fire.event,
      ...(fire.payload !== undefined ? { payload: fire.payload } : {}),
    },
  };
}
