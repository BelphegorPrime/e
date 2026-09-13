/**
 * **One call to a Remote agent.** Both ways `e` talks to an agent hosted
 * elsewhere - `e spawn <remote> "<prompt>"` and a Remote agent requested as a
 * Sibling run - are the same five steps: resolve the endpoint's headers, send
 * the prompt, follow the task until it settles, cancel it if the caller
 * aborts, and read the state and the answer off the result.
 *
 * They were written twice and had begun to differ in which task states they
 * named. The sequence lives here; what the two callers still decide for
 * themselves is what an outcome *means* - one prints an answer and returns an
 * exit code, the other writes a Spool status - which is genuinely their own
 * business and stays with them.
 */

import {
  taskAnswer,
  wireTaskState,
  type A2aClient,
  type A2aEndpoint,
} from './client.js';
import {
  resolveRemoteHeaders,
  type RemoteA2aAgent,
} from '../../core/agent/remoteAgent.js';
import { partsText } from './wire.js';
import { errorMessage } from '../../shared/utils/errors.js';
import type { TaskState } from '../../sidecars/broker/contract/types.js';

/**
 * The slice of {@link A2aClient} a call uses. Named so a test can hand over a
 * plain object instead of a cast, and so the dependency reads as three
 * methods rather than the whole client.
 */
export type RemoteCallClient = Pick<
  A2aClient,
  'sendMessage' | 'waitForTask' | 'cancelTask'
>;

export interface RemoteCallOptions {
  agent: RemoteA2aAgent;
  prompt: string;
  /** The store env (`.e/.env`) the headers' `${VAR}` references resolve from. */
  storeEnv: Record<string, string | undefined>;
  client: RemoteCallClient;
  /** Correlates the remote task with the local request, when the caller has one. */
  requestId?: string;
  /** How often to ask the remote for the task's state. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Aborting cancels the remote task as well as the wait. */
  signal?: AbortSignal;
}

/**
 * How a call ended. Every case carries whatever text came back, because a
 * remote that failed or asked a question usually said why, and both callers
 * pass that on.
 */
export type RemoteCallOutcome =
  /** The remote answered directly, without opening a task at all. */
  | { kind: 'answer'; answer: string }
  /** The task reached a terminal state (or `input-required`, which for `e` is terminal). */
  | { kind: 'settled'; taskId: string; state: TaskState; answer: string }
  /** The caller aborted; the remote task was asked to cancel. */
  | { kind: 'canceled'; taskId: string; answer: string }
  /** The call never got that far: unresolved headers, or the transport failed. */
  | { kind: 'failed'; error: string };

/**
 * Sends `prompt` to the Remote agent and follows the task to an outcome.
 * Never throws: a transport failure and an unset `${VAR}` in the agent's
 * headers are both a `failed` outcome, because both callers have to report
 * them rather than propagate them.
 */
export async function callRemoteAgent(
  options: RemoteCallOptions
): Promise<RemoteCallOutcome> {
  const { agent, client, signal } = options;
  let endpoint: A2aEndpoint;
  try {
    endpoint = {
      url: agent.url,
      headers: resolveRemoteHeaders(agent, options.storeEnv),
    };
  } catch (err) {
    return { kind: 'failed', error: errorMessage(err) };
  }

  let taskId: string | undefined;
  // Registered before the wait so an abort that arrives mid-poll still reaches
  // the remote; removed afterwards so a long-lived signal keeps no listener.
  const onAbort = (): void => {
    if (taskId !== undefined) void client.cancelTask(endpoint, taskId);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const sent = await client.sendMessage(endpoint, options.prompt, {
      source: 'e',
      ...(options.requestId !== undefined
        ? { requestId: options.requestId }
        : {}),
    });
    if (sent.kind === 'message') {
      return { kind: 'answer', answer: partsText(sent.message.parts) };
    }
    taskId = sent.task.id;
    // An abort that arrived while `sendMessage` was in flight found no id to
    // cancel, so the remote would have kept working with nobody waiting for
    // it. The window is real: the server has the prompt as soon as it reads
    // the request, while this line waits for the response to come back.
    if (signal?.aborted) {
      void client.cancelTask(endpoint, taskId);
      return { kind: 'canceled', taskId, answer: '' };
    }
    const task = await client.waitForTask(endpoint, sent.task, {
      pollMs: options.pollMs ?? DEFAULT_POLL_MS,
      sleep: options.sleep,
      signal,
    });
    const answer = taskAnswer(task);
    if (signal?.aborted) return { kind: 'canceled', taskId: task.id, answer };
    return {
      kind: 'settled',
      taskId: task.id,
      state: wireTaskState(task),
      answer,
    };
  } catch (err) {
    return { kind: 'failed', error: errorMessage(err) };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/** A remote task is polled, not streamed; two seconds is slow enough to be cheap. */
const DEFAULT_POLL_MS = 2000;
