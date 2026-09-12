/**
 * The HTTP plumbing both sidecar servers share: a bounded body reader, a JSON
 * writer, a path-segment decoder and the error tail every request ends in.
 * Only the plumbing - the routing stays with each sidecar, because the
 * broker's endpoints over a Spool and egress's over a dnsmasq log have nothing
 * in common beyond `node:http`.
 *
 * It lives here because two copies had already grown two answers to the same
 * question: the broker mapped an oversized body to 413 in its tail while
 * egress answered it inside one POST route, so a route added to the wrong one
 * got a 500. One owner, one answer, and `BodyTooLarge` stays unexported so no
 * route can start disagreeing again.
 *
 * Only Node built-ins are used: esbuild inlines this file into both container
 * bundles (`scripts/build-broker.mjs`, `scripts/build-egress-api.mjs`) and
 * fails the build on anything else.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorMessage } from '../shared/utils/errors.js';

/** What `http.createServer` takes - the shape both `create*Api` factories return. */
export type SidecarHandler = (
  req: IncomingMessage,
  res: ServerResponse
) => void;

/**
 * `writeJson` narrowed to one sidecar's response union. Each API binds it once
 * so a body shape its contract never declared is a compile error at the call
 * site instead of whatever `JSON.stringify` makes of it.
 */
export type JsonSender<Body> = (
  res: ServerResponse,
  status: number,
  body: Body
) => void;

/**
 * A spawn request is one agent name and one prompt; a blacklist mutation is
 * one short domain. Anything past this is abuse rather than a client mistake,
 * so it is refused instead of buffered.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * What `readBody` rejects with past the cap. Deliberately not exported: the
 * error tail is the only place allowed to turn it into a status, which is what
 * keeps the two sidecars from drifting apart again.
 */
class BodyTooLarge extends Error {}

/** Writes `body` as the whole JSON response. See `JsonSender` for the typed form. */
export function writeJson<Body>(
  res: ServerResponse,
  status: number,
  body: Body
): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * The whole request body, up to `MAX_BODY_BYTES`. Past the cap it stops
 * reading and drops what it collected, but leaves the socket alive: both
 * copies used to destroy the request right here, which raced the response and
 * cost the client the status - measured, the 413 never once arrived. Tearing
 * the socket down is `withErrorTail`'s job, after the 413 is on the wire.
 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    const onData = (chunk: Buffer | string): void => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        req.off('data', onData);
        req.pause();
        body = '';
        reject(new BodyTooLarge('Request body too large'));
      }
    };
    req.on('data', onData);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** Decodes a path segment; `null` for malformed percent-escapes (a URIError). */
export function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Wraps a sidecar's async router into the handler `http.createServer` wants,
 * and owns the tail every request ends in: 413 for a body past the cap, 500
 * with the message for anything else. A router that already wrote headers -
 * the broker's SSE stream - only gets its response closed, since its status
 * line is long gone.
 */
export function withErrorTail(
  route: (req: IncomingMessage, res: ServerResponse) => Promise<void>
): SidecarHandler {
  return (req, res) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof BodyTooLarge) {
        // Drop the connection only once the status has flushed; the rest of
        // the body is never read, so a slow sender cannot hold the socket.
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }), () => req.destroy());
        return;
      }
      writeJson(res, 500, { error: errorMessage(err) });
    });
  };
}
