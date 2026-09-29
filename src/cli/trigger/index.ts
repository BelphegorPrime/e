import type { Command } from 'commander';
import { storeTriggerContext } from '../../core/trigger/context.js';
import { findRoot } from '../../core/store/root.js';
import { loadTriggers, type LoadedTrigger } from '../../core/trigger/load.js';
import { triggersBaseDir } from '../../core/store/paths.js';
import { log } from '../../shared/utils/log.js';

/**
 * `e trigger` (ADR-0016): the read surface over the Store's triggers. A
 * trigger that has never fired is invisible in the run list, which is exactly
 * the "why is my schedule not running?" case - so the listing is where that
 * question is answered, and where a trigger that failed to load says why.
 * That makes this command the linter for trigger files.
 */

/** One rendered line, at the level it should be read at. */
export interface TriggerLine {
  level: 'info' | 'warn';
  text: string;
}

/** A one-line summary of what a trigger listens to. */
function sourceSummary(loaded: LoadedTrigger): string {
  const on = loaded.trigger!.on;
  if (on.type === 'cron') {
    return `cron ${on.expr}${on.tz ? ` ${on.tz}` : ' UTC'}`;
  }
  const action = on.action ? `.${on.action}` : '';
  return `${on.source} ${on.event}${action}`;
}

/** Renders the listing. Pure, so the shape is testable without a Store. */
export function triggerListLines(loaded: LoadedTrigger[]): TriggerLine[] {
  if (loaded.length === 0) {
    return [{ level: 'info', text: 'No triggers in this store.' }];
  }
  return loaded.map(entry => {
    // Disabled and failed-to-load are both inactive, for very different
    // reasons, so they never render alike.
    if (entry.error) {
      return { level: 'warn' as const, text: `${entry.name}: ${entry.error}` };
    }
    const state = entry.trigger!.enabled ? '' : ' (disabled)';
    return {
      level: 'info' as const,
      text: `${entry.name}${state}: ${sourceSummary(entry)} -> ${entry.trigger!.agent}`,
    };
  });
}

/** Registers `e trigger list`. */
export function registerTriggerCommands(program: Command): void {
  const trigger = program
    .command('trigger')
    .description('Inspect the triggers that may start a run without a human');

  trigger
    .command('list')
    .description("List this store's triggers, with any that failed to load")
    .option(
      '-d, --dir <path>',
      'store root to read (default: walk up from cwd)'
    )
    .action((options: { dir?: string }) => {
      const root = findRoot(options.dir);
      log.debug(`Reading triggers from ${triggersBaseDir(root)}`);
      for (const line of triggerListLines(
        loadTriggers(root, storeTriggerContext(root))
      )) {
        log[line.level](line.text);
      }
    });
}
