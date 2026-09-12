/**
 * Entry module of the `spawn-brother` skill script (ADR-0013). esbuild bundles
 * it into `spawn-brother.mjs`, seeded into the Store skill and run by the agent
 * with the harness image's own `node` (every harness image has one; `curl`
 * is not guaranteed). It only speaks HTTP to the broker named by
 * `$E_BROKER_URL`; no runtime socket, no git.
 */

import {
  SPAWN_BROTHER_USAGE,
  brokerBaseUrl,
  parseSpawnBrotherArgs,
} from './cliArgs.js';

async function main(argv: string[]): Promise<number> {
  const command = parseSpawnBrotherArgs(argv);
  if (command.kind === 'help') {
    console.log(SPAWN_BROTHER_USAGE);
    return 0;
  }
  const base = brokerBaseUrl(process.env);
  let response: Response;
  try {
    response =
      command.kind === 'spawn'
        ? await fetch(`${base}/spawn`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              agent: command.agent,
              prompt: command.prompt,
            }),
          })
        : command.kind === 'merge'
          ? await fetch(`${base}/merge/${encodeURIComponent(command.id)}`, {
              method: 'POST',
            })
          : await fetch(
              command.id === undefined
                ? `${base}/status`
                : `${base}/status/${encodeURIComponent(command.id)}`
            );
  } catch (err) {
    console.error(
      `spawn-brother: the runtime-broker at ${base} did not answer (${(err as Error).message}). ` +
        'Sibling spawning is unavailable in this run: record the task as a file in the worktree instead.'
    );
    return 3;
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
