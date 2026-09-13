/**
 * A remote A2A agent as a **sibling** (ADR-0015): the parent's request names
 * a Store agent with `transport: "a2a"`, so instead of a child `e spawn`
 * process the host sends the prompt over A2A in-process and reports the
 * outcome into the same spool, in the same states, so the parent's skill,
 * the report and the merge-back (skipped: no branch) see one kind of
 * sibling. The result is the answer text in the status (`answer`) and the
 * report; the {@link ChildHandle} shape lets the consumer cancel it like
 * a process.
 *
 * The call itself - resolve, send, follow, cancel - is `remoteCall.ts`,
 * shared with `e spawn <remote>`. What is decided here is only what each
 * outcome means for a *sibling*, which is where the two genuinely differ: a
 * sibling has no terminal to print to and no way to answer a question, so
 * `input-required` is a failure rather than a prompt to the user.
 */

import type {
  SpawnRequest,
  TaskState,
} from '../../sidecars/broker/contract/types.js';
import { reportChildRun, type ChildHandle } from '../runs/childRun.js';
import { log } from '../../shared/utils/log.js';

import type { RemoteA2aAgent } from '../../core/agent/remoteAgent.js';
import { callRemoteAgent, type RemoteCallClient } from './remoteCall.js';

export interface RemoteSiblingOptions {
  agent: RemoteA2aAgent;
  request: SpawnRequest;
  /** The parent's spool, where the status goes under `request.id`. */
  spoolDir: string;
  /** The store env (`.e/.env`) the headers' `${VAR}` references resolve from. */
  storeEnv: Record<string, string | undefined>;
  client: RemoteCallClient;
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
): ChildHandle {
  const { agent, request, spoolDir } = options;
  const cancel = new AbortController();
  const target = { spoolDir, id: request.id };
  const report = (patch: Parameters<typeof reportChildRun>[1]): void =>
    reportChildRun(target, patch, options.now);

  const exited = (async (): Promise<number> => {
    report({ status: 'running' });
    const outcome = await callRemoteAgent({
      agent,
      prompt: request.prompt,
      storeEnv: options.storeEnv,
      client: options.client,
      requestId: request.id,
      pollMs: options.pollMs,
      sleep: options.sleep,
      signal: cancel.signal,
    });

    switch (outcome.kind) {
      case 'answer':
        report({ status: 'done', exitCode: 0, answer: outcome.answer });
        return 0;
      case 'canceled':
        report({ status: 'failed', error: 'canceled', answer: outcome.answer });
        return 1;
      case 'failed':
        log.warn(
          `Sibling ${request.id}: remote agent ${agent.name} (${agent.url}) failed: ${outcome.error}`
        );
        report({
          status: 'failed',
          error: `remote agent ${agent.name}: ${outcome.error}`,
        });
        return 1;
      case 'settled':
        return settle(report, outcome.state, outcome.answer);
    }
  })();

  return { exited, kill: () => cancel.abort() };
}

/** What a settled remote task means for a sibling, state by state. */
function settle(
  report: (patch: Parameters<typeof reportChildRun>[1]) => void,
  state: TaskState,
  answer: string
): number {
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
}
