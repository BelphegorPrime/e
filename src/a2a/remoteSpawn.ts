/**
 * `e spawn <remote-agent> "<prompt>"` (ADR-0015): a Store agent with
 * `transport: "a2a"` has no container to run, so the spawn pipeline is not
 * entered at all - the host sends the prompt over A2A, follows the task, and
 * prints the answer. No worktree, no branch, no PR: the answer is the
 * deliverable. Interactive use makes no sense for a remote agent, so a
 * prompt is required.
 */

import { log } from '../utils/log.js';
import {
  A2aClient,
  isSettled,
  taskAnswer,
  wireTaskState,
  type A2aEndpoint,
} from './client.js';
import { resolveRemoteHeaders, type RemoteA2aAgent } from './remoteAgent.js';
import { partsText } from './wire.js';

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
  const client = options.client ?? new A2aClient();
  const print = options.print ?? ((text: string) => console.log(text));
  const endpoint: A2aEndpoint = {
    url: agent.url,
    headers: resolveRemoteHeaders(agent, options.storeEnv),
  };
  log.info(`Sending the prompt to remote agent ${agent.name} at ${agent.url}`);
  const sent = await client.sendMessage(endpoint, prompt, { source: 'e' });
  if (sent.kind === 'message') {
    print(partsText(sent.message.parts));
    return 0;
  }
  let task = sent.task;
  const onAbort = (): void => {
    void client.cancelTask(endpoint, task.id);
  };
  options.abort?.addEventListener('abort', onAbort, { once: true });
  try {
    task = await client.waitForTask(endpoint, task, {
      pollMs: options.pollMs ?? 2000,
      sleep: options.sleep,
      signal: options.abort,
    });
  } finally {
    options.abort?.removeEventListener('abort', onAbort);
  }
  const state = wireTaskState(task);
  const answer = taskAnswer(task);
  if (answer !== '') print(answer);
  if (options.abort?.aborted && !isSettled(state)) {
    log.warn(`Remote task ${task.id} canceled`);
    return 1;
  }
  switch (state) {
    case 'completed':
      log.success(`Remote agent ${agent.name} completed task ${task.id}`);
      return 0;
    case 'input-required':
      log.warn(
        `Remote agent ${agent.name} asked for more input on task ${task.id}; answer it with a new, fuller prompt.`
      );
      return 1;
    default:
      log.error(`Remote agent ${agent.name}: task ${task.id} ${state}`);
      return 1;
  }
}
