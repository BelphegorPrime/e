/**
 * Server-Sent Events over a polled snapshot (ADR-0015). The spool is files on
 * a bind mount, where `fs.watch` is unreliable, so the stream re-reads a
 * snapshot on an interval and sends a `status` event whenever its JSON
 * changed - the first one right away, so a client always starts with the
 * current state. A keep-alive comment keeps idle connections open. Used by
 * the broker (`GET /status/events`) and by `e serve` for the web UI; Node
 * built-ins only, because the broker bundle carries it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { errorMessage } from '../utils/errors.js';
export interface StatusEventStreamOptions {
  /** The current state; sent whenever its JSON differs from the last one sent. */
  snapshot: () => unknown;
  /** How often to re-read the snapshot. */
  pollMs: number;
  /** How often to send a keep-alive comment. */
  heartbeatMs: number;
  /** The SSE event name; `status` by default. */
  event?: string;
}

/** One SSE frame: `event: <name>` and a single-line JSON `data:`. */
export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Streams snapshot changes to `res` until the client goes away. Returns the
 * function that stops the timers (also called on `close`), for callers that
 * end the stream themselves.
 */
export function streamStatusEvents(
  _req: IncomingMessage,
  res: ServerResponse,
  options: StatusEventStreamOptions
): () => void {
  const event = options.event ?? 'status';
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  let last: string | undefined;
  const send = (): void => {
    let json: string;
    try {
      json = JSON.stringify(options.snapshot());
    } catch (err) {
      json = JSON.stringify({
        error: errorMessage(err),
      });
    }
    if (json === last) return;
    last = json;
    res.write(`event: ${event}\ndata: ${json}\n\n`);
  };

  send();
  const poll = setInterval(send, options.pollMs);
  const heartbeat = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, options.heartbeatMs);
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(poll);
    clearInterval(heartbeat);
    res.end();
  };
  // The response's `close` (the connection is gone or the stream was ended),
  // never the request's: since Node 16 a request "closes" once its body is
  // consumed, which would end the stream before its second event.
  res.on('close', stop);
  return stop;
}

/**
 * Parses SSE text incrementally (the client side of the stream above): call
 * `push` with each chunk, get every complete event back. Multi-line `data:`
 * is joined with newlines as the spec says; comments are dropped.
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): Array<{ event: string; data: string }> {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const events: Array<{ event: string; data: string }> = [];
    let end = this.buffer.indexOf('\n\n');
    while (end !== -1) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const parsed = parseSseBlock(block);
      if (parsed) events.push(parsed);
      end = this.buffer.indexOf('\n\n');
    }
    return events;
  }
}

function parseSseBlock(
  block: string
): { event: string; data: string } | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join('\n') };
}
