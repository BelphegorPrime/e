/**
 * A remote A2A agent as a **sibling** (ADR-0015): the parent's request names
 * a Store agent with `transport: "a2a"`, so instead of a child `e spawn`
 * process the host sends the prompt over A2A in-process and reports the
 * outcome into the same spool, in the same states, so the parent's skill,
 * the report and the merge-back (skipped: no branch) see one kind of
 * sibling. The result is the answer text in the status (`answer`) and the
 * report; the {@link SiblingProcess} shape lets the consumer cancel it like
 * a process.
 */

import type { SpawnRequest } from '../broker/types.js';
import { writeStatus } from '../broker/spool.js';
import type { SiblingProcess } from '../runs/runSiblings.js';
import { log } from '../utils/log.js';
import { A2aClient, taskAnswer, wireTaskState } from './client.js';
import { resolveRemoteHeaders, type RemoteA2aAgent } from './remoteAgent.js';
import { partsText } from './wire.js';

export interface RemoteSiblingOptions {
  agent: RemoteA2aAgent;
  request: SpawnRequest;
  /** The parent's spool, where the status goes under `request.id`. */
  spoolDir: string;
  /** The store env (`.e/.env`) the headers' `${VAR}` references resolve from. */
  storeEnv: Record<string, string | undefined>;
  client: A2aClient;
  /** How often to ask the remote for the task's state. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** Why a remote sibling that asked for input is reported failed. */
export const INPUT_REQUIRED_MESSAGE =
  'the remote agent asked for more input, which a sibling request cannot provide; its question is in the answer';

/**
 * Runs the request against the remote agent (see the module doc). Never
 * throws: every way it can end is a status in the spool and an exit code -
 * 0 for an answer, 1 for a failure, whatever the consumer decides for a
 * cancel (it marks the record itself).
 */
export function remoteSiblingProcess(
  options: RemoteSiblingOptions
): SiblingProcess {
  const { agent, request, spoolDir, client } = options;
  const now = options.now ?? (() => new Date());
  const cancel = new AbortController();
  let remoteTaskId: string | undefined;
  const report = (patch: Record<string, unknown>): void => {
    writeStatus(spoolDir, request.id, {
      status: 'running',
      ...patch,
      updatedAt: now().toISOString(),
    } as Parameters<typeof writeStatus>[2]);
  };

  const exited = (async (): Promise<number> => {
    let endpoint;
    try {
      endpoint = {
        url: agent.url,
        headers: resolveRemoteHeaders(agent, options.storeEnv),
      };
    } catch (err) {
      report({ status: 'failed', error: (err as Error).message });
      return 1;
    }
    report({ status: 'running' });
    try {
      const sent = await client.sendMessage(endpoint, request.prompt, {
        source: 'e',
        requestId: request.id,
      });
      if (sent.kind === 'message') {
        report({
          status: 'done',
          exitCode: 0,
          answer: partsText(sent.message.parts),
        });
        return 0;
      }
      remoteTaskId = sent.task.id;
      const task = await client.waitForTask(endpoint, sent.task, {
        pollMs: options.pollMs ?? 2000,
        sleep: options.sleep,
        signal: cancel.signal,
      });
      const state = wireTaskState(task);
      const answer = taskAnswer(task);
      if (cancel.signal.aborted) {
        report({ status: 'failed', error: 'canceled', answer });
        return 1;
      }
      switch (state) {
        case 'completed':
          report({ status: 'done', exitCode: 0, answer });
          return 0;
        case 'input-required':
          report({ status: 'failed', error: INPUT_REQUIRED_MESSAGE, answer });
          return 1;
        case 'canceled':
          report({
            status: 'failed',
            error: 'the remote agent canceled the task',
            answer,
          });
          return 1;
        case 'rejected':
          report({
            status: 'failed',
            error: `the remote agent rejected the task${answer ? `: ${answer}` : ''}`,
            answer,
          });
          return 1;
        default:
          report({
            status: 'failed',
            error: `the remote agent failed the task${answer ? `: ${answer}` : ''}`,
            answer,
          });
          return 1;
      }
    } catch (err) {
      const message = (err as Error).message;
      log.warn(
        `Sibling ${request.id}: remote agent ${agent.name} (${agent.url}) failed: ${message}`
      );
      report({
        status: 'failed',
        error: `remote agent ${agent.name}: ${message}`,
      });
      return 1;
    }
  })();

  return {
    exited,
    kill: () => {
      cancel.abort();
      if (remoteTaskId !== undefined) {
        const endpoint = {
          url: agent.url,
          headers: safeHeaders(agent, options.storeEnv),
        };
        void client.cancelTask(endpoint, remoteTaskId).then(outcome => {
          if (!outcome.ok) {
            log.debug(
              `Sibling ${request.id}: remote cancel refused: ${outcome.error}`
            );
          }
        });
      }
    },
  };
}

function safeHeaders(
  agent: RemoteA2aAgent,
  env: Record<string, string | undefined>
): Record<string, string> {
  try {
    return resolveRemoteHeaders(agent, env);
  } catch {
    return {};
  }
}
