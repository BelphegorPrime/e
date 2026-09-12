/**
 * The pure half of the `spawn-brother` skill script: argv parsing and the
 * broker base URL from the run's env. Node built-ins only (bundled).
 */

import { BROKER_URL_ENV } from './constants.js';

export type SpawnBrotherCommand =
  | { kind: 'help' }
  | { kind: 'status'; id?: string }
  | { kind: 'merge'; id: string }
  | { kind: 'cancel'; id: string }
  | { kind: 'watch'; id?: string }
  | { kind: 'spawn'; agent: string; prompt: string };

/** How long `--watch` blocks at most before giving up (exit 4). */
export const WATCH_TIMEOUT_MS = 30 * 60 * 1000;

export const SPAWN_BROTHER_USAGE = [
  'usage: node spawn-brother.mjs <agent> <task description...>',
  '       node spawn-brother.mjs --status [<id>]',
  '       node spawn-brother.mjs --watch [<id>]',
  '       node spawn-brother.mjs --merge <id>',
  '       node spawn-brother.mjs --cancel <id>',
  '',
  'Requests a sibling run ("brother") from the runtime-broker at $E_BROKER_URL,',
  'lists the status of every sibling requested from this run, blocks until one',
  'of them (or the one named) needs your attention (its taskState becomes',
  'input-required, completed, failed, canceled or rejected), signals that a',
  "sibling's held or conflicted merge-back may be retried (its files are clear,",
  'or its conflict markers are resolved), or cancels a sibling.',
  'Exit codes: 0 ok, 1 the broker refused, 2 usage, 3 the broker did not answer,',
  '4 --watch timed out.',
].join('\n');

/** Parses the script's argv (without `node` and the script path). */
export function parseSpawnBrotherArgs(argv: string[]): SpawnBrotherCommand {
  const [first, ...rest] = argv;
  if (first === undefined || first === '-h' || first === '--help') {
    return { kind: 'help' };
  }
  if (first === '--status' || first === '--watch') {
    const kind = first === '--status' ? 'status' : 'watch';
    if (rest.length > 1) {
      throw new Error(`${first} takes at most one sibling id.`);
    }
    return rest[0] === undefined ? { kind } : { kind, id: rest[0] };
  }
  if (first === '--merge' || first === '--cancel') {
    if (rest.length !== 1) {
      throw new Error(`${first} takes exactly one sibling id.`);
    }
    return first === '--merge'
      ? { kind: 'merge', id: rest[0] }
      : { kind: 'cancel', id: rest[0] };
  }
  if (first.startsWith('-')) {
    throw new Error(`Unknown option "${first}".`);
  }
  const prompt = rest.join(' ').trim();
  if (prompt === '') {
    throw new Error('A task description for the brother is required.');
  }
  return { kind: 'spawn', agent: first, prompt };
}

/** `$E_BROKER_URL` without a trailing slash; throws when the run did not set it. */
export function brokerBaseUrl(env: Record<string, string | undefined>): string {
  const raw = env[BROKER_URL_ENV]?.trim() ?? '';
  if (raw === '') {
    throw new Error(
      `$${BROKER_URL_ENV} is not set: this is not an e run with a runtime-broker.`
    );
  }
  return raw.replace(/\/+$/, '');
}
