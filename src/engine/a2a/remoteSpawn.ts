/**
 * `e spawn <remote-agent> "<prompt>"` (ADR-0015): a Store agent with
 * `transport: "a2a"` has no container to run, so the spawn pipeline is not
 * entered at all - the host sends the prompt over A2A, follows the task, and
 * prints the answer. No worktree, no branch, no PR: the answer is the
 * deliverable. Interactive use makes no sense for a remote agent, so a
 * prompt is required.
 */

import { log } from '../../shared/utils/log.js';
import { A2aClient } from './client.js';
import type { RemoteA2aAgent } from '../../core/agent/remoteAgent.js';
import { callRemoteAgent } from './remoteCall.js';

export interface RemoteSpawnOptions {
  agent: RemoteA2aAgent;
  prompt: string;
  /** The store env (`.e/.env`) the headers' `${VAR}` references resolve from. */
  storeEnv: Record<string, string | undefined>;
  client?: A2aClient;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Where the answer goes; `console.log` by default. */
  print?: (text: string) => void;
  /** A cancel (SIGTERM): the remote task is canceled too. */
  abort?: AbortSignal;
}

/**
 * Runs the prompt against the remote agent and prints its answer. Returns the
 * exit code: 0 for a completed task (or a direct answer), 1 for anything else
 * (a failure, a rejection, a question `e` cannot answer, a cancel).
 */
export async function runRemoteAgent(
  options: RemoteSpawnOptions
): Promise<number> {
  const { agent, prompt } = options;
  if (prompt.trim() === '') {
    throw new Error(
      `Agent "${agent.name}" is a remote A2A agent: it takes a prompt and answers it; there is no interactive session to start.`
    );
  }
  const print = options.print ?? ((text: string) => console.log(text));
  log.info(`Sending the prompt to remote agent ${agent.name} at ${agent.url}`);

  const outcome = await callRemoteAgent({
    agent,
    prompt,
    storeEnv: options.storeEnv,
    client: options.client ?? new A2aClient(),
    pollMs: options.pollMs,
    sleep: options.sleep,
    signal: options.abort,
  });

  if (outcome.kind !== 'failed' && outcome.answer !== '') print(outcome.answer);
  switch (outcome.kind) {
    case 'answer':
      return 0;
    case 'failed':
      log.error(`Remote agent ${agent.name}: ${outcome.error}`);
      return 1;
    case 'canceled':
      log.warn(`Remote task ${outcome.taskId} canceled`);
      return 1;
    case 'settled':
      if (outcome.state === 'completed') {
        log.success(
          `Remote agent ${agent.name} completed task ${outcome.taskId}`
        );
        return 0;
      }
      if (outcome.state === 'input-required') {
        log.warn(
          `Remote agent ${agent.name} asked for more input on task ${outcome.taskId}; answer it with a new, fuller prompt.`
        );
        return 1;
      }
      log.error(
        `Remote agent ${agent.name}: task ${outcome.taskId} ${outcome.state}`
      );
      return 1;
  }
}
