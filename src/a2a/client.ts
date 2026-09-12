/**
 * The A2A **client** side of `e` (ADR-0015): how the host talks to a remote
 * agent (`transport: "a2a"` in the Store) over the JSON-RPC binding - send
 * the prompt as a message, follow the task it opens until it is over, take
 * the artifacts as the answer, cancel on request. Plain `fetch`, no SDK: the
 * subset is small and the wire shapes live in `wire.ts`.
 */

import { randomUUID } from 'node:crypto';
import type { TaskState } from '../broker/types.js';
import {
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  A2A_METHODS,
  fromWireState,
  partsText,
  taskFromResult,
  type WireMessage,
  type WireTask,
} from './wire.js';
import type { JsonRpcResponse } from './jsonRpc.js';

/** Where a remote agent listens and what to send along. */
export interface A2aEndpoint {
  url: string;
  headers?: Record<string, string>;
}

/** The remote agent answered a request with a JSON-RPC error. */
export class A2aRemoteError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
  }
}

/** What `message/send` came back with: a task to follow, or a direct message. */
export type SendOutcome =
  { kind: 'task'; task: WireTask } | { kind: 'message'; message: WireMessage };

export interface A2aClientOptions {
  fetchImpl?: typeof fetch;
  /** Message id factory, for tests. */
  newId?: () => string;
  /** Per-request timeout. */
  timeoutMs?: number;
}

/** The task's state in `e`'s vocabulary; an unreadable state counts as `working`. */
export function wireTaskState(task: WireTask): TaskState {
  return fromWireState(task.status?.state) ?? 'working';
}

/**
 * The answer in a task: every text part of every artifact, then the status
 * message's text when the artifacts said nothing (a failure reason, a
 * question). Empty when the agent said nothing at all.
 */
export function taskAnswer(task: WireTask): string {
  const artifacts = (task.artifacts ?? [])
    .map(artifact => partsText(artifact.parts))
    .filter(text => text !== '')
    .join('\n\n');
  if (artifacts !== '') return artifacts;
  return partsText(task.status?.message?.parts);
}

export class A2aClient {
  private readonly fetchImpl: typeof fetch;
  private readonly newId: () => string;
  private readonly timeoutMs: number;

  constructor(options: A2aClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.newId = options.newId ?? randomUUID;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** One JSON-RPC call; the `result`, or an {@link A2aRemoteError} for an `error`. */
  async call(
    endpoint: A2aEndpoint,
    method: string,
    params: unknown
  ): Promise<unknown> {
    const response = await this.fetchImpl(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
        ...endpoint.headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.newId(),
        method,
        params,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let body: JsonRpcResponse;
    try {
      body = JSON.parse(text) as JsonRpcResponse;
    } catch {
      throw new A2aRemoteError(
        response.status,
        `${endpoint.url} answered HTTP ${response.status} with a non-JSON body${text ? `: ${text.slice(0, 200)}` : ''}`
      );
    }
    if (body.error) {
      throw new A2aRemoteError(
        body.error.code,
        body.error.message,
        body.error.data
      );
    }
    if (!response.ok) {
      throw new A2aRemoteError(
        response.status,
        `${endpoint.url} answered HTTP ${response.status}`
      );
    }
    return body.result;
  }

  /** `message/send` with `text` as the user's message; `metadata` rides the message. */
  async sendMessage(
    endpoint: A2aEndpoint,
    text: string,
    metadata?: Record<string, unknown>
  ): Promise<SendOutcome> {
    // `returnImmediately`: a 1.0 server otherwise holds the response until
    // the task is over (blocking mode, the reference SDK's default), which for
    // a long task means a timeout here; `e` polls `GetTask` instead.
    const result = await this.call(endpoint, A2A_METHODS.sendMessage, {
      message: {
        messageId: this.newId(),
        role: 'ROLE_USER',
        parts: [{ text }],
        ...(metadata ? { metadata } : {}),
      },
      configuration: { returnImmediately: true },
    });
    const task = taskFromResult(result);
    if (task) return { kind: 'task', task };
    const record = (result ?? {}) as Record<string, unknown>;
    const message =
      'message' in record ? (record.message as WireMessage) : undefined;
    if (message && Array.isArray(message.parts)) {
      return { kind: 'message', message };
    }
    if (Array.isArray(record.parts)) {
      return { kind: 'message', message: record as unknown as WireMessage };
    }
    throw new A2aRemoteError(
      -32006,
      `${endpoint.url} answered message/send with neither a task nor a message`
    );
  }

  async getTask(endpoint: A2aEndpoint, id: string): Promise<WireTask> {
    const task = taskFromResult(
      await this.call(endpoint, A2A_METHODS.getTask, { id })
    );
    if (!task) {
      throw new A2aRemoteError(
        -32006,
        `${endpoint.url} answered tasks/get without a task`
      );
    }
    return task;
  }

  /** `tasks/cancel`; the remote's refusal (already over, not cancelable) is returned, not thrown. */
  async cancelTask(
    endpoint: A2aEndpoint,
    id: string
  ): Promise<{ ok: true; task?: WireTask } | { ok: false; error: string }> {
    try {
      const result = await this.call(endpoint, A2A_METHODS.cancelTask, { id });
      return { ok: true, task: taskFromResult(result) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Polls `tasks/get` until the task is terminal or waits for input, or
   * `signal` aborts (the last task seen is returned then). `sleep` is
   * injectable so tests run without timers.
   */
  async waitForTask(
    endpoint: A2aEndpoint,
    task: WireTask,
    options: {
      pollMs: number;
      sleep?: (ms: number) => Promise<void>;
      signal?: AbortSignal;
    }
  ): Promise<WireTask> {
    const sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    let current = task;
    while (!isSettled(wireTaskState(current))) {
      if (options.signal?.aborted) return current;
      await sleep(options.pollMs);
      if (options.signal?.aborted) return current;
      current = await this.getTask(endpoint, current.id);
    }
    return current;
  }
}

/** A task state the remote will not move on from by itself. */
export function isSettled(state: TaskState): boolean {
  return state !== 'submitted' && state !== 'working';
}
