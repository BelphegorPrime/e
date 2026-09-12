/**
 * JSON-RPC 2.0 envelopes for the A2A binding (ADR-0015), pure: parse a
 * request body into a validated request or the error response it deserves,
 * and build result / error responses. A2A adds its own error codes on top of
 * the standard ones (`wire.ts`).
 */

import { JSON_RPC_ERROR_CODES } from './wire.js';

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorBody;
}

/** An error the handler raises to answer a request with a JSON-RPC error. */
export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
  }
}

export function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

/** The response for a thrown error: a {@link JsonRpcError} as is, anything else an internal error. */
export function rpcErrorFrom(id: JsonRpcId, err: unknown): JsonRpcResponse {
  if (err instanceof JsonRpcError) {
    return rpcError(id, err.code, err.message, err.data);
  }
  return rpcError(
    id,
    JSON_RPC_ERROR_CODES.internalError,
    err instanceof Error ? err.message : String(err)
  );
}

/**
 * Parses one JSON-RPC 2.0 request (batches are not part of the A2A binding).
 * Returns the request, or the error response to send back.
 */
export function parseJsonRpcRequest(
  raw: string
):
  | { ok: true; request: JsonRpcRequest }
  | { ok: false; response: JsonRpcResponse } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      response: rpcError(
        null,
        JSON_RPC_ERROR_CODES.parseError,
        'Request body is not valid JSON.'
      ),
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: rpcError(
        null,
        JSON_RPC_ERROR_CODES.invalidRequest,
        'A JSON-RPC request is a single object; batches are not supported.'
      ),
    };
  }
  const record = parsed as Record<string, unknown>;
  const id = isJsonRpcId(record.id) ? record.id : null;
  if (record.jsonrpc !== '2.0') {
    return {
      ok: false,
      response: rpcError(
        id,
        JSON_RPC_ERROR_CODES.invalidRequest,
        '"jsonrpc" must be "2.0".'
      ),
    };
  }
  if (typeof record.method !== 'string' || record.method === '') {
    return {
      ok: false,
      response: rpcError(
        id,
        JSON_RPC_ERROR_CODES.invalidRequest,
        '"method" must be a non-empty string.'
      ),
    };
  }
  if (
    record.params !== undefined &&
    (typeof record.params !== 'object' || record.params === null)
  ) {
    return {
      ok: false,
      response: rpcError(
        id,
        JSON_RPC_ERROR_CODES.invalidRequest,
        '"params" must be an object or an array.'
      ),
    };
  }
  return {
    ok: true,
    request: {
      jsonrpc: '2.0',
      id,
      method: record.method,
      ...(record.params !== undefined ? { params: record.params } : {}),
    },
  };
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    value === null || typeof value === 'string' || typeof value === 'number'
  );
}
