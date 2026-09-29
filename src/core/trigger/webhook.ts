import crypto from 'node:crypto';
import { WEBHOOK_SOURCES, type Trigger, type WebhookSource } from './index.js';
import { matchesEvent, readPath } from './match.js';
import { overlapDrop, triggerRequest, type TriggerFire } from './fire.js';
import { EVENT_ID_PATTERN } from './provenance.js';

/**
 * **The webhook edge's pure half** (ADR-0016 section 7): the signature over
 * the raw body, and one delivery fanned out to the triggers it matches. The
 * listener in `cli/serve/webhookServer.ts` reads the bytes, the secret and the
 * declarations and hands them in; everything decided about a delivery is
 * decided here, without I/O.
 *
 * **The HMAC is the whole authentication**, on every interface: a tunnel
 * delivers an internet request on loopback, so the peer address says nothing.
 */

/**
 * `E_WEBHOOK_SECRET_<SOURCE>`, read from the serving Store's `.e/.env`: one
 * per source, because a shared endpoint verifies before it knows which
 * trigger matches. Never in `trigger.json` (it goes into git) and never in
 * `process.env` (a detached restart would lose it).
 */
export function webhookSecretVar(source: WebhookSource): string {
  return `E_WEBHOOK_SECRET_${source.toUpperCase()}`;
}

/** The headers a source's delivery carries, lower-cased as Node reads them. */
export interface WebhookHeaders {
  /** The provider's event name. */
  event: string;
  /** The provider's id for this delivery: the dedup value, and the `E-Event` id. */
  delivery: string;
  /** The signature over the raw body. */
  signature: string;
}

export const WEBHOOK_HEADERS: Record<WebhookSource, WebhookHeaders> = {
  github: {
    event: 'x-github-event',
    delivery: 'x-github-delivery',
    signature: 'x-hub-signature-256',
  },
};

/** GitHub's scheme: `sha256=` and the hex HMAC-SHA256 of the raw body. */
export function signWebhookBody(
  _source: WebhookSource,
  secret: string,
  body: Buffer
): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * True only when `header` is the signature of exactly these bytes, compared
 * in constant time. An **empty header is a mismatch, not an absence**: Gitea
 * and Forgejo send the headers even with no secret configured.
 */
export function verifyWebhookSignature(
  source: WebhookSource,
  secret: string,
  body: Buffer,
  header: string | undefined
): boolean {
  if (header === undefined || header === '') return false;
  const expected = Buffer.from(signWebhookBody(source, secret, body));
  const actual = Buffer.from(header);
  // timingSafeEqual throws on a length mismatch; the length is no secret.
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}

/**
 * The source's secret out of `envValue` (a key of the serving Store's
 * `.e/.env`), or undefined. A blank value is no secret: an empty HMAC key
 * would verify a body anybody can sign.
 */
export function webhookSecret(
  envValue: (name: string) => string | undefined,
  source: WebhookSource
): string | undefined {
  const secret = envValue(webhookSecretVar(source))?.trim();
  return secret ? secret : undefined;
}

/** Whether the listener opens, and for which sources. */
export type WebhookListenerAccess =
  | { enabled: true; sources: WebhookSource[] }
  | { enabled: false; reason: string };

/**
 * **With no secret configured the port does not open at all**: a closed port
 * is unambiguous where a 503 invites a retry.
 */
export function webhookListenerAccess(
  envValue: (name: string) => string | undefined,
  envFile: string
): WebhookListenerAccess {
  const sources = WEBHOOK_SOURCES.filter(
    source => webhookSecret(envValue, source) !== undefined
  );
  if (sources.length > 0) return { enabled: true, sources };
  return {
    enabled: false,
    reason: `no webhook secret configured; set ${WEBHOOK_SOURCES.map(webhookSecretVar).join(' or ')} in ${envFile}`,
  };
}

/** One verified, parsed delivery. */
export interface WebhookDelivery {
  source: WebhookSource;
  /** The provider's event name, from its header. */
  name: string;
  /** The provider's delivery id, exactly as the header spelled it. */
  id: string;
  payload: unknown;
}

/** What {@link fireWebhook} needs besides the delivery. */
export interface FireContext {
  /** Triggers that own a run in the ledger that has not ended. */
  live: ReadonlySet<string>;
  /**
   * The dedup value for a delivery id that cannot be written down: a fresh
   * id, so an unusable id never collides with another delivery's.
   */
  fallbackId: string;
}

/** A payload value as the text it is written as, or undefined. */
function textAt(payload: unknown, path: string): string | undefined {
  const value = readPath(payload, path);
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : undefined;
}

/**
 * **One delivery fans out to N triggers, N requests**, each keyed
 * `<trigger id>:<dedup value>`. A trigger that does not listen for this
 * delivery - disabled, another source or event, a `match` that disagrees -
 * produces nothing; one that does either becomes a request or names why it
 * drops. Dedup against pending requests is the queue's (the key is the file);
 * `overlap` is decided here, against the live runs the caller hands in.
 */
export function fireWebhook(
  triggers: readonly Trigger[],
  delivery: WebhookDelivery,
  ctx: FireContext
): TriggerFire[] {
  const fires: TriggerFire[] = [];
  for (const trigger of triggers) {
    const on = trigger.on;
    if (!trigger.enabled || on.type !== 'webhook') continue;
    if (on.source !== delivery.source) continue;
    if (!matchesEvent(on, { name: delivery.name, payload: delivery.payload })) {
      continue;
    }
    fires.push(fireOne(trigger, delivery, ctx));
  }
  return fires;
}

function fireOne(
  trigger: Trigger,
  delivery: WebhookDelivery,
  ctx: FireContext
): TriggerFire {
  const drop = (dropped: string): TriggerFire => ({
    trigger: trigger.name,
    dropped,
  });
  const overlap = overlapDrop(trigger, ctx.live);
  if (overlap !== undefined) return drop(overlap);

  // Absent, the source's own identity; declared, a coarser subject. A
  // declared path that is missing drops the event: falling back would widen
  // the key and turn a misconfigured trigger into a queue flood.
  let dedupValue: string;
  if (trigger.dedup !== undefined) {
    const value = textAt(delivery.payload, trigger.dedup);
    if (value === undefined || value === '') {
      return drop(`dedup path "${trigger.dedup}" is missing from the payload`);
    }
    dedupValue = value;
  } else {
    dedupValue = EVENT_ID_PATTERN.test(delivery.id)
      ? delivery.id
      : ctx.fallbackId;
  }

  return triggerRequest(trigger, {
    dedupValue,
    event: { source: delivery.source, event: delivery.name, id: delivery.id },
    payload: delivery.payload,
  });
}
