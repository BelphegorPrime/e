/**
 * The A2A **server** side of `e serve` (ADR-0015): the agent card and one
 * JSON-RPC endpoint (`POST /a2a`) over the {@link A2aTasks}. Express
 * handlers only; every decision (parsing, access, task rendering) is in the
 * pure modules next to this one. `message/stream` and `tasks/subscribe`
 * answer with Server-Sent Events whose `data` lines are JSON-RPC responses
 * carrying one stream result each, as the 1.0 binding says.
 */

import type { Request, RequestHandler, Response } from 'express';
import { formatSseEvent } from '../broker/events.js';
import { bearerMatches, type A2aAccess } from './access.js';
import {
  JsonRpcError,
  parseJsonRpcRequest,
  rpcErrorFrom,
  rpcResult,
  type JsonRpcId,
  type JsonRpcResponse,
} from './jsonRpc.js';
import type { A2aTasks } from './tasks.js';
import {
  A2A_ERROR_CODES,
  A2A_METHODS,
  A2A_PROTOCOL_VERSION,
  A2A_PUSH_METHODS,
  A2A_VERSION_HEADER,
  JSON_RPC_ERROR_CODES,
  canonicalMethod,
  type WireAgentCard,
  type WireStreamResult,
} from './wire.js';

export interface A2aServerDeps {
  tasks: A2aTasks;
  /** The card, rendered per request so a new Store agent shows up without a restart. */
  card: () => WireAgentCard;
  access: A2aAccess;
}

function sendRpc(res: Response, response: JsonRpcResponse): void {
  res.status(200).set(A2A_VERSION_HEADER, A2A_PROTOCOL_VERSION).json(response);
}

/** `GET /.well-known/agent-card.json`; 404 while the endpoint is disabled. */
export function agentCardHandler(deps: A2aServerDeps): RequestHandler {
  return (_req, res) => {
    if (!deps.access.enabled) {
      res.status(404).json({ error: deps.access.reason });
      return;
    }
    res.set(A2A_VERSION_HEADER, A2A_PROTOCOL_VERSION).json(deps.card());
  };
}

/** Access refused: the JSON-RPC error to send, or undefined when the request may proceed. */
function refusal(
  req: Request,
  access: A2aAccess
): { status: number; body: unknown } | undefined {
  if (!access.enabled) {
    return { status: 503, body: { error: access.reason } };
  }
  if (
    access.requireBearer &&
    !bearerMatches(req.header('authorization'), access.token ?? '')
  ) {
    return {
      status: 401,
      body: {
        error: 'A bearer token (E_A2A_TOKEN) is required on this endpoint.',
      },
    };
  }
  return undefined;
}

/**
 * `POST /a2a`: one JSON-RPC request per call. Expects the raw body as text
 * (`express.text`), so parse errors are JSON-RPC errors, not HTML 400s.
 */
export function a2aRpcHandler(deps: A2aServerDeps): RequestHandler {
  return (req, res) => {
    const refused = refusal(req, deps.access);
    if (refused) {
      res.status(refused.status).json(refused.body);
      return;
    }
    const raw =
      typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? '');
    const parsed = parseJsonRpcRequest(raw);
    if (!parsed.ok) {
      sendRpc(res, parsed.response);
      return;
    }
    const { id, params } = parsed.request;
    // 1.0 RPC names, with the 0.x slash names as aliases for older clients.
    const method = canonicalMethod(parsed.request.method);
    try {
      switch (method) {
        case A2A_METHODS.sendMessage:
          sendRpc(res, rpcResult(id, { task: deps.tasks.send(params) }));
          return;
        case A2A_METHODS.getTask:
          sendRpc(res, rpcResult(id, deps.tasks.get(paramId(params))));
          return;
        case A2A_METHODS.listTasks: {
          // The 1.0 `ListTasksResponse`: one page holding everything.
          const tasks = deps.tasks.list();
          sendRpc(
            res,
            rpcResult(id, {
              tasks,
              nextPageToken: '',
              pageSize: tasks.length,
              totalSize: tasks.length,
            })
          );
          return;
        }
        case A2A_METHODS.cancelTask:
          sendRpc(res, rpcResult(id, deps.tasks.cancel(paramId(params))));
          return;
        case A2A_METHODS.streamMessage: {
          const task = deps.tasks.send(params);
          stream(res, id, deps.tasks, task.id, { task });
          return;
        }
        case A2A_METHODS.subscribeTask: {
          const taskId = paramId(params);
          const task = deps.tasks.get(taskId);
          stream(res, id, deps.tasks, task.id, { task });
          return;
        }
        case A2A_METHODS.getExtendedAgentCard:
          throw new JsonRpcError(
            A2A_ERROR_CODES.extendedAgentCardNotConfigured,
            'No extended agent card; the public card is the whole card.'
          );
        default:
          if (A2A_PUSH_METHODS.includes(method)) {
            throw new JsonRpcError(
              A2A_ERROR_CODES.pushNotificationNotSupported,
              'Push notifications are not supported; use SendStreamingMessage or SubscribeToTask.'
            );
          }
          throw new JsonRpcError(
            JSON_RPC_ERROR_CODES.methodNotFound,
            `Unknown method "${parsed.request.method}".`
          );
      }
    } catch (err) {
      if (res.headersSent) return;
      sendRpc(res, rpcErrorFrom(id, err));
    }
  };
}

/** `params.id` of `tasks/get` / `tasks/cancel` / `tasks/subscribe`. */
function paramId(params: unknown): unknown {
  return typeof params === 'object' && params !== null
    ? (params as Record<string, unknown>).id
    : undefined;
}

/**
 * The SSE answer of `message/stream` and `tasks/subscribe`: the task first,
 * then every change until the final status update, each as a JSON-RPC
 * response with the same request id.
 */
function stream(
  res: Response,
  rpcId: JsonRpcId,
  tasks: A2aTasks,
  taskId: string,
  first: WireStreamResult
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
  });
  res.flushHeaders?.();
  const write = (result: WireStreamResult): void => {
    res.write(formatSseEvent('message', rpcResult(rpcId, result)));
  };
  write(first);
  let unsubscribe: (() => void) | undefined = undefined;
  let ended = false;
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
  const end = (): void => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    unsubscribe?.();
    res.end();
  };
  // A task already over replays its final events synchronously, inside
  // `subscribe`; `end` then runs before `unsubscribe` exists, which is fine.
  unsubscribe = tasks.subscribe(taskId, event => {
    write(event);
    if ('statusUpdate' in event && event.statusUpdate.final) end();
  });
  if (ended) unsubscribe();
  // The response's `close`, not the request's: since Node 16 a request
  // "closes" as soon as its body is consumed, which for a POST is right away.
  res.on('close', end);
}
