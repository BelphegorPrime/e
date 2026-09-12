/**
 * The runtime-broker HTTP API (ADR-0013), as a plain `node:http` handler. The
 * broker never touches a container runtime or git: `POST /spawn` only spools
 * the request for the host `e` process, and `GET /status` reports what the
 * host has written back. Stateless between requests - the spool directory is
 * the single source of truth, so a restarted broker loses nothing.
 *
 * Only Node built-ins are used: the handler is bundled into a single
 * dependency-free `.mjs` that runs inside the `e-broker` image.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEPTH_LIMIT_MESSAGE,
  MERGE_SIGNAL_STATES,
  STATUS_EVENTS_HEARTBEAT_MS,
  STATUS_EVENTS_POLL_MS,
} from './constants.js';
import { streamStatusEvents } from './events.js';
import {
  countInFlight,
  ensureSpool,
  isRequestId,
  listRecords,
  nextRequestId,
  readRecord,
  readRunInfo,
  signalCancel,
  signalMerge,
  writeRequest,
} from './spool.js';
import { isTerminalSiblingState } from './taskState.js';
import type {
  CancelAccepted,
  ErrorResponse,
  MergeSignalAccepted,
  SiblingRecord,
  SpawnAccepted,
  SpawnRequestBody,
  StatusResponse,
} from './types.js';

export interface BrokerApiOptions {
  /** The spool directory (the bind mount inside the container). */
  spoolDir: string;
  /** Clock, for tests. */
  now?: () => Date;
  /** How often `GET /status/events` re-reads the spool; the default suits a bind mount. */
  eventsPollMs?: number;
  /** How often `GET /status/events` sends a keep-alive comment. */
  eventsHeartbeatMs?: number;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const STATUS_EVENTS_PATH = '/status/events';
const STATUS_ONE_RE = /^\/status\/([^/]+)$/;
const MERGE_ONE_RE = /^\/merge\/([^/]+)$/;
const CANCEL_ONE_RE = /^\/cancel\/([^/]+)$/;
/** A spawn request is one agent name and one prompt; anything bigger is abuse. */
const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLarge extends Error {}

function sendJson(
  res: ServerResponse,
  status: number,
  body:
    | SpawnAccepted
    | MergeSignalAccepted
    | CancelAccepted
    | StatusResponse
    | SiblingRecord
    | ErrorResponse
    | { status: 'ok' }
): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer | string) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new BodyTooLarge('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Validates a `POST /spawn` body purely: both fields present, non-blank
 * strings. Returns the trimmed body or the error message to send back.
 */
export function parseSpawnBody(
  raw: string
): { ok: true; body: SpawnRequestBody } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }
  const { agent, prompt } = parsed as Record<string, unknown>;
  if (typeof agent !== 'string' || agent.trim() === '') {
    return { ok: false, error: '"agent" must be a non-empty string.' };
  }
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { ok: false, error: '"prompt" must be a non-empty string.' };
  }
  return { ok: true, body: { agent: agent.trim(), prompt: prompt.trim() } };
}

/** Decodes a path segment; `null` for malformed percent-escapes (a URIError). */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Builds the request handler; `http.createServer(createBrokerApi({ spoolDir }))`. */
export function createBrokerApi(options: BrokerApiOptions): Handler {
  const { spoolDir } = options;
  const now = options.now ?? (() => new Date());

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://broker');
    } catch {
      return sendJson(res, 400, { error: 'Malformed request URL.' });
    }
    const method = req.method ?? 'GET';

    if (url.pathname === '/health') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'Use GET.' });
      return sendJson(res, 200, { status: 'ok' });
    }

    if (url.pathname === '/spawn') {
      if (method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
      const parsed = parseSpawnBody(await readBody(req));
      if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
      // Depth and fan-out (ADR-0013), answered right away so the agent does
      // not wait on a request the host would refuse anyway; the host enforces
      // both again when it picks requests up.
      const run = readRunInfo(spoolDir);
      if (run?.role === 'child') {
        return sendJson(res, 403, { error: DEPTH_LIMIT_MESSAGE });
      }
      if (run) {
        // Accepted-but-not-yet-picked-up counts too: the host will pick it up.
        const inFlight = countInFlight(spoolDir, [
          'requested',
          'starting',
          'running',
        ]);
        if (inFlight >= run.maxSiblings) {
          return sendJson(res, 429, {
            error: `Sibling cap reached (${run.maxSiblings} in flight); retry when one finishes.`,
          });
        }
      }
      ensureSpool(spoolDir);
      const id = nextRequestId(spoolDir);
      writeRequest(spoolDir, {
        id,
        ...parsed.body,
        requestedAt: now().toISOString(),
      });
      return sendJson(res, 202, {
        id,
        status: 'requested',
        statusPath: `/status/${id}`,
      });
    }

    const snapshot = (): StatusResponse => ({
      run: readRunInfo(spoolDir),
      siblings: listRecords(spoolDir),
    });

    if (url.pathname === '/status') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'Use GET.' });
      return sendJson(res, 200, snapshot());
    }

    // The same snapshot as a Server-Sent Events stream (ADR-0015): one
    // `status` event now and one on every change, so an agent (or a UI) can
    // block on "something happened" instead of polling with sleeps.
    if (url.pathname === STATUS_EVENTS_PATH) {
      if (method !== 'GET') return sendJson(res, 405, { error: 'Use GET.' });
      streamStatusEvents(req, res, {
        snapshot,
        pollMs: options.eventsPollMs ?? STATUS_EVENTS_POLL_MS,
        heartbeatMs: options.eventsHeartbeatMs ?? STATUS_EVENTS_HEARTBEAT_MS,
      });
      return;
    }

    const one = STATUS_ONE_RE.exec(url.pathname);
    if (one) {
      if (method !== 'GET') return sendJson(res, 405, { error: 'Use GET.' });
      const id = decodeSegment(one[1]);
      const record =
        id !== null && isRequestId(id) ? readRecord(spoolDir, id) : undefined;
      if (!record) {
        return sendJson(res, 404, {
          error: `Unknown sibling "${id ?? one[1]}".`,
        });
      }
      return sendJson(res, 200, record);
    }

    // The parent's merge signal (ticket 07): "the files you named are clear"
    // or "the conflict is resolved" - the host retries that sibling's
    // merge-back. Only a merge that is waiting on the parent takes one.
    const mergeOne = MERGE_ONE_RE.exec(url.pathname);
    if (mergeOne) {
      if (method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
      const id = decodeSegment(mergeOne[1]);
      const record =
        id !== null && isRequestId(id) ? readRecord(spoolDir, id) : undefined;
      if (!record || id === null) {
        return sendJson(res, 404, {
          error: `Unknown sibling "${id ?? mergeOne[1]}".`,
        });
      }
      const state = record.merge?.status;
      if (state === undefined || !MERGE_SIGNAL_STATES.includes(state)) {
        return sendJson(res, 409, {
          error: `Nothing to retry for ${id}: its merge-back is ${state ?? 'not started'} (only ${MERGE_SIGNAL_STATES.join(' or ')} takes a signal).`,
        });
      }
      signalMerge(spoolDir, id, now().toISOString());
      return sendJson(res, 202, {
        id,
        status: 'merge-requested',
        statusPath: `/status/${id}`,
      });
    }

    // The parent's cancel (ADR-0015, A2A `tasks/cancel`): spooled for the
    // host, which stops the sibling (or never starts it) and writes
    // `canceled`. A request the host is already done with has nothing to
    // cancel.
    const cancelOne = CANCEL_ONE_RE.exec(url.pathname);
    if (cancelOne) {
      if (method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
      const id = decodeSegment(cancelOne[1]);
      const record =
        id !== null && isRequestId(id) ? readRecord(spoolDir, id) : undefined;
      if (!record || id === null) {
        return sendJson(res, 404, {
          error: `Unknown sibling "${id ?? cancelOne[1]}".`,
        });
      }
      if (isTerminalSiblingState(record.status)) {
        return sendJson(res, 409, {
          error: `Nothing to cancel for ${id}: it is already ${record.status}.`,
        });
      }
      signalCancel(spoolDir, id, now().toISOString());
      return sendJson(res, 202, {
        id,
        status: 'cancel-requested',
        statusPath: `/status/${id}`,
      });
    }

    return sendJson(res, 404, { error: 'Not found.' });
  };

  return (req, res) => {
    handle(req, res).catch(err => {
      if (res.headersSent) return;
      if (err instanceof BodyTooLarge) {
        sendJson(res, 413, { error: err.message });
      } else {
        sendJson(res, 500, { error: errorMessage(err) });
      }
    });
  };
}
