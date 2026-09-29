import type { Command } from 'commander';
import path from 'node:path';
import { storeTriggerContext } from '../../core/trigger/context.js';
import { findRoot } from '../../core/store/root.js';
import { loadTriggers } from '../../core/trigger/load.js';
import {
  listingActivity,
  triggerListing,
  type TriggerListingResponse,
  type TriggerListItem,
} from '../../core/trigger/listing.js';
import { eBaseDir, triggersBaseDir } from '../../core/store/paths.js';
import { readConfig } from '../../core/store/config.js';
import { redrive } from '../../engine/queue/redrive.js';
import {
  listDead,
  runsDirs,
  type DeadRequest,
} from '../../engine/queue/runsSpool.js';
import { log } from '../../shared/utils/log.js';
import type { ServeState } from '../serve/detachedServe.js';
import { readStoreServe } from '../serve/storeServe.js';

/**
 * `e trigger` (ADR-0016): the read surface over the Store's triggers. A
 * trigger that has never fired is invisible in the run list, which is exactly
 * the "why is my schedule not running?" case - so the listing is where that
 * question is answered, and where a trigger that failed to load says why.
 * That makes this command the linter for trigger files.
 *
 * `nextFireAt` is computed here and needs no `serve`. When and what a trigger
 * last fired lives only in a running `serve`'s memory, so it is asked of the
 * `serve` this Store records in `.e/runs/serve.json` - foreground or
 * detached; otherwise it reads unknown.
 */

/** One rendered line, at the level it should be read at. */
export interface TriggerLine {
  level: 'info' | 'warn';
  text: string;
}

/** When the trigger last fired, as far as anybody knows. */
function lastFired(
  item: TriggerListItem,
  serve?: Pick<TriggerListingResponse, 'activitySince'>
): string {
  if (item.lastFiredAt !== null) {
    return `last fired ${item.lastFiredAt} (${item.lastRequestId})`;
  }
  if (!serve) return 'last fired unknown (no serve answering for this store)';
  if (serve.activitySince === null) {
    return 'last fired unknown (serve has no run queue)';
  }
  return `last fired unknown (not since serve started ${serve.activitySince})`;
}

/** Renders the listing. Pure, so the shape is testable without a Store. */
export function triggerListLines(
  items: readonly TriggerListItem[],
  /** What the `serve` that answered said about its memory; undefined when none did. */
  serve?: Pick<TriggerListingResponse, 'activitySince'>
): TriggerLine[] {
  if (items.length === 0) {
    return [{ level: 'info', text: 'No triggers in this store.' }];
  }
  return items.map(item => {
    // Disabled and failed-to-load are both inactive, for very different
    // reasons, so they never render alike.
    if (item.error !== undefined) {
      return { level: 'warn' as const, text: `${item.id}: ${item.error}` };
    }
    const state = item.enabled ? '' : ' (disabled)';
    const parts = [`${item.id}${state}: ${item.on} -> ${item.agent}`];
    if (item.type === 'cron' && item.enabled) {
      parts.push(
        `next ${item.nextFireAt ?? 'never (the schedule matches no date)'}`
      );
    }
    parts.push(lastFired(item, serve));
    return { level: 'info' as const, text: parts.join('; ') };
  });
}

/**
 * `e trigger dead`: the requests that died before a run branch existed,
 * oldest death first, metadata only - never a payload.
 */
export function deadListLines(dead: readonly DeadRequest[]): TriggerLine[] {
  if (dead.length === 0) {
    return [{ level: 'info', text: 'No dead requests.' }];
  }
  return dead.map(({ request, stage, reason, diedAt }) => ({
    level: 'info' as const,
    text: `${request.id} ${request.key} (${stage}, ${diedAt}): ${reason}`,
  }));
}

/** Where a client reaches a `serve` bound to `host`: a wildcard bind answers on loopback. */
function reachableHost(host: string): string {
  if (host === '0.0.0.0' || host === '') return '127.0.0.1';
  if (host === '::') return '[::1]';
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * Asks this Store's `serve` for its listing, if one is recorded and answers
 * for the Store `root` - a stale record's port may by now be another Store's
 * `serve`, whose memory names other triggers. Undefined on anything else,
 * fast: this is a lookup, not a dependency.
 */
export async function fetchServeListing(
  root: string | undefined,
  state: ServeState | undefined = readStoreServe(eBaseDir(root)),
  timeoutMs = 1000
): Promise<TriggerListingResponse | undefined> {
  if (!state) return undefined;
  try {
    const res = await fetch(
      `http://${reachableHost(state.host)}:${state.port}/api/triggers`,
      { signal: AbortSignal.timeout(timeoutMs) }
    );
    if (!res.ok) return undefined;
    const body = (await res.json()) as TriggerListingResponse;
    return path.resolve(body.store) === path.resolve(eBaseDir(root))
      ? body
      : undefined;
  } catch {
    return undefined;
  }
}

/** `--dir`, as every `e trigger` command takes it. */
const DIR_OPTION = [
  '-d, --dir <path>',
  'store root to read (default: walk up from cwd)',
] as const;

/** Registers `e trigger list`, `dead` and `redrive`. */
export function registerTriggerCommands(program: Command): void {
  const trigger = program
    .command('trigger')
    .description('Inspect the triggers that may start a run without a human');

  trigger
    .command('list')
    .description("List this store's triggers, with any that failed to load")
    .option(...DIR_OPTION)
    .action(async (options: { dir?: string }) => {
      const root = findRoot(options.dir);
      log.debug(`Reading triggers from ${triggersBaseDir(root)}`);
      const serve = await fetchServeListing(root);
      const items = triggerListing(
        loadTriggers(root, storeTriggerContext(root)),
        new Date(),
        { activity: listingActivity(serve) }
      );
      for (const line of triggerListLines(items, serve)) {
        log[line.level](line.text);
      }
    });

  trigger
    .command('dead')
    .description(
      'List the requests that died before a run branch existed (expired, overflow, base, launch)'
    )
    .option(...DIR_OPTION)
    .action((options: { dir?: string }) => {
      const root = findRoot(options.dir);
      for (const line of deadListLines(listDead(runsDirs(eBaseDir(root))))) {
        log[line.level](line.text);
      }
    });

  trigger
    .command('redrive <id>')
    .description(
      'Accept a dead request again against the current trigger declaration; a running serve starts it'
    )
    .option(...DIR_OPTION)
    .action((id: string, options: { dir?: string }) => {
      const root = findRoot(options.dir);
      const result = redrive(
        {
          dirs: runsDirs(eBaseDir(root)),
          store: { root, context: () => storeTriggerContext(root) },
          maxLength: readConfig(root).queue.maxLength,
        },
        id
      );
      if (result.status === 'refused') {
        throw new Error(`Not redriven: ${result.reason}`);
      }
      log.info(
        `Redrove ${result.request.id} (${result.request.key}); a running serve starts it on its next tick`
      );
    });
}
