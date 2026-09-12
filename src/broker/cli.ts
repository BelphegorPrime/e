/**
 * Entry module of the `spawn-brother` skill script (ADR-0013). esbuild bundles
 * it into `spawn-brother.mjs`, seeded into the Store skill and run by the agent
 * with the harness image's own `node` (every harness image has one; `curl`
 * is not guaranteed). It only speaks HTTP to the broker named by
 * `$E_BROKER_URL`; no runtime socket, no git.
 */

import {
  SPAWN_BROTHER_USAGE,
  WATCH_TIMEOUT_MS,
  brokerBaseUrl,
  parseSpawnBrotherArgs,
  type SpawnBrotherCommand,
} from './cliArgs.js';
import { SseParser } from './events.js';
import type { SiblingRecord, StatusResponse } from './types.js';
import { attentionSince } from './watch.js';

function unreachable(base: string, err: unknown): number {
  console.error(
    `spawn-brother: the runtime-broker at ${base} did not answer (${(err as Error).message}). ` +
      'Sibling spawning is unavailable in this run: record the task as a file in the worktree instead.'
  );
  return 3;
}

/**
 * `--watch [id]`: holds the `GET /status/events` stream open until a sibling
 * (or the one named) needs attention, prints those records as JSON and exits
 * 0; exits 4 when nothing happened within the timeout (a sibling can take
 * long, but not forever). A sibling id nobody requested is a refusal (1).
 */
async function watch(
  base: string,
  id: string | undefined,
  timeoutMs: number
): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${base}/status/events`, {
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return unreachable(base, err);
  }
  if (!response.ok || !response.body) {
    clearTimeout(timer);
    console.log(await response.text());
    return 1;
  }
  const parser = new SseParser();
  const decoder = new TextDecoder();
  let initial: SiblingRecord[] | undefined;
  try {
    for await (const chunk of response.body) {
      for (const event of parser.push(
        decoder.decode(chunk, { stream: true })
      )) {
        if (event.event !== 'status') continue;
        const { siblings } = JSON.parse(event.data) as StatusResponse;
        if (id !== undefined && !siblings.some(record => record.id === id)) {
          console.error(
            `spawn-brother: no sibling "${id}" was requested from this run.`
          );
          controller.abort();
          clearTimeout(timer);
          return 1;
        }
        const attention = attentionSince(initial, siblings, id);
        if (initial === undefined) initial = siblings;
        if (attention.length > 0) {
          console.log(JSON.stringify(attention));
          controller.abort();
          clearTimeout(timer);
          return 0;
        }
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) return unreachable(base, err);
  }
  clearTimeout(timer);
  console.error(
    `spawn-brother: --watch gave up after ${Math.round(timeoutMs / 60000)} minutes without a sibling needing attention; check --status.`
  );
  return 4;
}

function requestFor(
  base: string,
  command: SpawnBrotherCommand
): Promise<Response> {
  switch (command.kind) {
    case 'spawn':
      return fetch(`${base}/spawn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: command.agent, prompt: command.prompt }),
      });
    case 'merge':
      return fetch(`${base}/merge/${encodeURIComponent(command.id)}`, {
        method: 'POST',
      });
    case 'cancel':
      return fetch(`${base}/cancel/${encodeURIComponent(command.id)}`, {
        method: 'POST',
      });
    case 'status':
      return fetch(
        command.id === undefined
          ? `${base}/status`
          : `${base}/status/${encodeURIComponent(command.id)}`
      );
    default:
      throw new Error(`No request for ${command.kind}.`);
  }
}

async function main(argv: string[]): Promise<number> {
  const command = parseSpawnBrotherArgs(argv);
  if (command.kind === 'help') {
    console.log(SPAWN_BROTHER_USAGE);
    return 0;
  }
  const base = brokerBaseUrl(process.env);
  if (command.kind === 'watch') {
    return watch(base, command.id, WATCH_TIMEOUT_MS);
  }
  let response: Response;
  try {
    response = await requestFor(base, command);
  } catch (err) {
    return unreachable(base, err);
  }
  console.log(await response.text());
  return response.ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  err => {
    console.error(
      `spawn-brother: ${(err as Error).message}\n\n${SPAWN_BROTHER_USAGE}`
    );
    process.exit(2);
  }
);
