/**
 * **The cron step of the `serve` tick** (ADR-0016 section 8): the first thing
 * each 30 s tick does. No per-trigger timer, which would fire late after a
 * suspend without knowing it and would be a second place to count slots.
 *
 * **Stateless across restarts.** Each trigger's next fire is computed from
 * `now` when it is first seen - at start, on a reload, for a new trigger -
 * and never retroactively, so a `serve` stopped over a scheduled time fires
 * nothing on restart, and a fire missed past the grace (a suspend, a clock
 * jump) is discarded rather than caught up. Catch-up would need a durable
 * `lastFiredAt`, the one piece of state whose disagreement with reality is
 * unfixable.
 *
 * **Triggers reload per tick** by an mtime scan of `.e/triggers/`: an edit
 * takes effect within one tick and no restart severs live runs. A trigger
 * that fails to load - a bad expression among them - is logged once per
 * change and simply has no next fire; `serve` and the others keep running.
 */

import type { Trigger } from '../../core/trigger/index.js';
import {
  loadTrigger,
  triggerSignatures,
  type TriggerStore,
} from '../../core/trigger/load.js';
import {
  cronDue,
  cronFire,
  firstCronFire,
  nextCronFire,
  tickStamp,
} from '../../core/trigger/cron.js';
import { log } from '../../shared/utils/log.js';
import type { RunQueue } from './runQueue.js';

/** What the scheduler needs of the queue. */
export type SchedulerQueue = Pick<RunQueue, 'enqueue' | 'liveTriggers'>;

export interface CronSchedulerDeps {
  /** The serving Store's triggers. */
  store: TriggerStore;
  queue: SchedulerQueue;
}

/** One trigger directory as last read: its marker, and the schedule if it has one. */
interface Known {
  signature: string;
  trigger?: Trigger;
  nextFire?: Date;
}

export class CronScheduler {
  private readonly known = new Map<string, Known>();

  constructor(private readonly deps: CronSchedulerDeps) {}

  /** The next scheduled fire of `name`, or undefined for none (not cron, disabled, invalid, unknown). */
  nextFireAt(name: string): Date | undefined {
    return this.known.get(name)?.nextFire;
  }

  /** Reloads what changed, then fires what is due. */
  tick(now: Date): void {
    this.reload(now);
    let live: ReadonlySet<string> | undefined;
    for (const [name, entry] of this.known) {
      const { trigger, nextFire: scheduled } = entry;
      if (!trigger?.enabled || trigger.on.type !== 'cron') continue;
      const on = trigger.on;
      if (!scheduled) {
        // No next fire found last time: asked again each tick rather than
        // left off until the file changes. Cheap, and never retroactive.
        entry.nextFire = nextCronFire(on, now);
        continue;
      }
      switch (cronDue(scheduled, now)) {
        case 'wait':
          continue;
        case 'missed':
          log.warn(
            `Cron: ${name} missed its ${tickStamp(scheduled)} fire (serve was not ticking); discarded, not caught up`
          );
          entry.nextFire = nextCronFire(on, now);
          continue;
        case 'fire': {
          live ??= this.deps.queue.liveTriggers();
          const fire = cronFire(trigger, scheduled, live);
          if ('dropped' in fire) {
            log.warn(
              `Cron: ${name} did not start for ${tickStamp(scheduled)} (${fire.dropped})`
            );
          } else {
            // The queue logs what it took, and why it rejected.
            this.deps.queue.enqueue(fire.request);
          }
          // Forward from the fire, so the autumn hour is never replayed.
          entry.nextFire = nextCronFire(on, scheduled);
        }
      }
    }
  }

  /** The mtime scan: forgets what is gone, reloads what changed, keeps the rest. */
  private reload(now: Date): void {
    const { root, context } = this.deps.store;
    const signatures = triggerSignatures(root);
    for (const name of this.known.keys()) {
      if (!signatures.has(name)) this.known.delete(name);
    }
    for (const [name, signature] of signatures) {
      if (this.known.get(name)?.signature === signature) continue;
      const loaded = loadTrigger(name, root, context());
      if (!loaded.trigger) {
        log.warn(`Trigger ${name} is disabled until fixed: ${loaded.error}`);
        this.known.set(name, { signature });
        continue;
      }
      const { trigger } = loaded;
      const nextFire = firstCronFire(trigger, now);
      this.known.set(name, {
        signature,
        trigger,
        ...(nextFire ? { nextFire } : {}),
      });
    }
  }
}
