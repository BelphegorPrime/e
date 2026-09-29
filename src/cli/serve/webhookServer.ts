/**
 * **The webhook listener** (ADR-0016 section 7): `POST /hooks/<source>` on a
 * dedicated HTTP server at BFF port + 2, GitHub only in v1.
 *
 * **Its own port, not a BFF route.** A webhook must be reachable from the
 * internet, and a tunnel aimed at the BFF port would publish the whole BFF -
 * `POST /api/terminal/sessions` starts a run with full repo write access and
 * is unauthenticated on any interface. This server has one route and nothing
 * else behind it, so the tunnel cannot reach any of that.
 *
 * **Always accept and queue, answer fast, reject rarely**: no forge retries
 * automatically, so a delivery lost here is lost for good. The status map is
 * built around GitLab disabling a webhook after 4 consecutive non-2xx: a no
 * match or a full dedup is our own configuration and answers 200; only a
 * queue that accepted nothing at all answers 429.
 *
 * Every rejection logs the event name, the delivery id and the reason, and
 * **never the payload**.
 */

import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { isWebhookSource, type Trigger } from '../../core/trigger/index.js';
import type { TriggerFire } from '../../core/trigger/fire.js';
import { EVENT_PAYLOAD_MAX_BYTES } from '../../core/trigger/oneShot.js';
import {
  fireWebhook,
  verifyWebhookSignature,
  WEBHOOK_HEADERS,
  webhookListenerAccess,
  webhookSecret,
  type WebhookHeaders,
} from '../../core/trigger/webhook.js';
import { newUlid } from '../../engine/queue/runsSpool.js';
import type { RunQueue } from '../../engine/queue/runQueue.js';
import { errorMessage } from '../../shared/utils/errors.js';
import { log } from '../../shared/utils/log.js';
import {
  decodeSegment,
  readRawBody,
  withErrorTail,
  writeJson,
} from '../../sidecars/http.js';

/** The route prefix: `/hooks/<source>`. */
export const WEBHOOK_PATH_PREFIX = '/hooks/';

/**
 * 5 MB, not `/a2a`'s 1 MB: a GitHub `push` may carry 2048 commits. The same
 * cap bounds the one-shot `--event` file, and `/run/e/event.json` with it.
 */
export const WEBHOOK_PAYLOAD_MAX_BYTES = EVENT_PAYLOAD_MAX_BYTES;

/** The listener sits past the BFF (+0) and the OmniRoute embed proxy (+1). */
export function webhookPortFor(bffPort: number): number {
  return bffPort + 2;
}

export interface WebhookServerDeps {
  /**
   * A key of the serving Store's `.e/.env`, read at verification time: the
   * file may change under a running `serve`.
   */
  envValue(name: string): string | undefined;
  /** The Store's loadable triggers, read fresh per delivery. */
  triggers(): readonly Trigger[];
  queue: Pick<RunQueue, 'enqueue' | 'liveTriggers'>;
}

/** One trigger's request the queue took. */
export interface WebhookAccepted {
  trigger: string;
  /** The request id, `trg-<ulid>`. */
  id: string;
  key: string;
}

/** One trigger that matched and started nothing, and why. */
export interface WebhookRejected {
  trigger: string;
  reason: string;
}

export type WebhookReplyBody =
  | { accepted: WebhookAccepted[]; rejected: WebhookRejected[] }
  | { error: string };

export interface WebhookReply {
  status: number;
  body: WebhookReplyBody;
}

/** A delivery with its body read, not yet verified. */
export interface WebhookInput {
  /** The `<source>` path segment, as the URL spelled it. */
  source: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** A header's one value; a repeated header reads as its first. */
function header(
  headers: IncomingHttpHeaders,
  name: string
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Log-safe: quoted, so a newline in a header cannot forge a log line. */
function quoted(value: string | undefined): string {
  return value === undefined ? '(none)' : JSON.stringify(value);
}

/** What a delivery's headers say, read by its source's names; nothing for a source `e` does not speak. */
interface DeliveryHeaders {
  names?: WebhookHeaders;
  event?: string;
  delivery?: string;
}

function readDeliveryHeaders(
  source: string,
  headers: IncomingHttpHeaders
): DeliveryHeaders {
  if (!isWebhookSource(source)) return {};
  const names = WEBHOOK_HEADERS[source];
  return {
    names,
    event: header(headers, names.event),
    delivery: header(headers, names.delivery),
  };
}

/** What every log line about a delivery names: its event and its id, never its payload. */
function deliveryLabel(seen: DeliveryHeaders): string {
  return `event ${quoted(seen.event)}, delivery ${quoted(seen.delivery)}`;
}

/**
 * Everything after the body is read: authenticate, parse, fan out, enqueue,
 * map to a status. Verification happens over the raw bytes before any parse,
 * and a source without a secret is as unknown as a source `e` does not speak.
 */
export function handleWebhookDelivery(
  deps: WebhookServerDeps,
  input: WebhookInput
): WebhookReply {
  const { source } = input;
  const seen = readDeliveryHeaders(source, input.headers);
  const { names, event: eventName, delivery: deliveryId } = seen;
  const label = deliveryLabel(seen);
  const reject = (status: number, reason: string): WebhookReply => {
    log.warn(
      `Webhook ${quoted(input.source)} rejected (${status}): ${reason}; ${label}`
    );
    return { status, body: { error: reason } };
  };

  // A source without a secret is as unknown as one `e` does not speak.
  const secret = isWebhookSource(source)
    ? webhookSecret(deps.envValue, source)
    : undefined;
  if (!isWebhookSource(source) || !names || secret === undefined) {
    return reject(404, `unknown webhook source ${quoted(source)}`);
  }
  if (
    !verifyWebhookSignature(
      source,
      secret,
      input.body,
      header(input.headers, names.signature)
    )
  ) {
    return reject(401, 'signature mismatch');
  }
  if (!eventName) {
    return reject(400, `missing ${names.event} header`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(input.body.toString('utf8'));
  } catch {
    return reject(400, 'malformed JSON body');
  }

  const fires = fireWebhook(
    deps.triggers(),
    { source, name: eventName, id: deliveryId ?? '', payload },
    { live: deps.queue.liveTriggers(), fallbackId: newUlid() }
  );
  const { accepted, rejected, full } = enqueueFires(deps, fires);
  for (const r of rejected) {
    log.warn(`Webhook: ${r.trigger} did not start (${r.reason}); ${label}`);
  }
  if (fires.length === 0) {
    log.info(`Webhook: no trigger matched; ${label}`);
  }

  const body = { accepted, rejected };
  // A 429 would be a lie the moment one run was accepted.
  if (accepted.length > 0) return { status: 202, body };
  if (full) return { status: 429, body };
  return { status: 200, body };
}

/** Enqueues each fired request in declaration order, collecting the outcome. */
function enqueueFires(
  deps: WebhookServerDeps,
  fires: readonly TriggerFire[]
): { accepted: WebhookAccepted[]; rejected: WebhookRejected[]; full: boolean } {
  const accepted: WebhookAccepted[] = [];
  const rejected: WebhookRejected[] = [];
  let full = false;
  for (const fire of fires) {
    if ('dropped' in fire) {
      rejected.push({ trigger: fire.trigger, reason: fire.dropped });
      continue;
    }
    const result = deps.queue.enqueue(fire.request);
    switch (result.status) {
      case 'enqueued':
        accepted.push({
          trigger: fire.trigger,
          id: result.request.id,
          key: result.request.key,
        });
        break;
      case 'duplicate':
        rejected.push({
          trigger: fire.trigger,
          reason: `already pending (${fire.request.key})`,
        });
        break;
      case 'full':
        full = true;
        rejected.push({ trigger: fire.trigger, reason: 'the queue is full' });
        break;
    }
  }
  return { accepted, rejected, full };
}

/** The listener's one route; everything else is 404. */
export function createWebhookHandler(
  deps: WebhookServerDeps
): (req: IncomingMessage, res: ServerResponse) => void {
  return withErrorTail(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://listener').pathname;
    const segment = pathname.startsWith(WEBHOOK_PATH_PREFIX)
      ? decodeSegment(pathname.slice(WEBHOOK_PATH_PREFIX.length))
      : null;
    if (segment === null || segment === '' || segment.includes('/')) {
      writeJson(res, 404, { error: 'not found' });
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      writeJson(res, 405, { error: 'method not allowed' });
      return;
    }
    let body: Buffer;
    try {
      body = await readRawBody(req, WEBHOOK_PAYLOAD_MAX_BYTES);
    } catch (err) {
      // The error tail answers (413 past the cap); the rejection is logged here.
      log.warn(
        `Webhook ${quoted(segment)} rejected: ${errorMessage(err)} (cap ${WEBHOOK_PAYLOAD_MAX_BYTES} bytes); ${deliveryLabel(readDeliveryHeaders(segment, req.headers))}`
      );
      throw err;
    }
    const reply = handleWebhookDelivery(deps, {
      source: segment,
      headers: req.headers,
      body,
    });
    writeJson(res, reply.status, reply.body);
  });
}

/** Starts the listener on `host:port`. */
export function startWebhookServer(
  host: string,
  port: number,
  deps: WebhookServerDeps
): Promise<Server> {
  const server = http.createServer(createWebhookHandler(deps));
  return new Promise((resolve, reject) => {
    server.listen(port, host);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

/** What the caller hands {@link openWebhookListener}. */
export interface WebhookListenerOptions extends Omit<
  WebhookServerDeps,
  'queue'
> {
  host: string;
  port: number;
  /** The serving Store's `.e/.env`, named in the warning when no secret is in it. */
  envFile: string;
  /** The run queue; without one nothing a delivery fires could start. */
  queue: WebhookServerDeps['queue'] | undefined;
}

/** The listener, and the line `serve` logs about it. */
export type WebhookListener =
  { server: Server; urls: string[] } | { server?: undefined; warning: string };

/**
 * Opens the listener, or says why not. **With no secret configured the port
 * does not open at all**, in the voice of `A2A endpoint disabled: ...`; nor
 * without a queue, which would make every delivery a 500.
 */
export async function openWebhookListener(
  options: WebhookListenerOptions
): Promise<WebhookListener> {
  const { host, port, envFile, queue } = options;
  const access = webhookListenerAccess(options.envValue, envFile);
  if (!access.enabled) {
    return { warning: `Webhook listener disabled: ${access.reason}` };
  }
  if (!queue) {
    return {
      warning:
        'Webhook listener disabled: the run queue is disabled, so nothing a delivery fires could start',
    };
  }
  const server = await startWebhookServer(host, port, { ...options, queue });
  const bound = (server.address() as AddressInfo).port;
  return {
    server,
    urls: access.sources.map(
      source => `http://${host}:${bound}${WEBHOOK_PATH_PREFIX}${source}`
    ),
  };
}
