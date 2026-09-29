/**
 * `GET /api/triggers` (ADR-0016 section 8): every trigger in the serving
 * Store, whatever its source, with `nextFireAt` and what `serve` remembers of
 * its last fire. The listing exposes prompts' agents and `repo` paths on the
 * unauthenticated BFF and inherits ticket 70's exposure unchanged: redacting
 * fields would break the diagnosis this route exists for.
 */

import { Router } from 'express';
import path from 'node:path';
import { eBaseDir } from '../../core/store/paths.js';
import {
  triggerListing,
  type TriggerListingResponse,
} from '../../core/trigger/listing.js';
import { loadTriggers, type TriggerStore } from '../../core/trigger/load.js';
import type { CronScheduler } from '../../engine/queue/cronScheduler.js';
import type { RunQueue } from '../../engine/queue/runQueue.js';
import { respondJson } from './apiResponse.js';

export const TRIGGERS_PATH = '/api/triggers';

export interface TriggersApiDeps {
  /** The serving Store's triggers. */
  store: TriggerStore;
  /** The run queue, whose memory holds the last fires; absent when it is disabled. */
  queue?: Pick<RunQueue, 'triggerActivity' | 'startedAt'>;
  /** The cron scheduler, whose next fire is the one about to happen. */
  scheduler?: Pick<CronScheduler, 'nextFireAt'>;
  now?: () => Date;
}

/** The listing as the route answers it. */
export function triggersResponse(
  deps: TriggersApiDeps
): TriggerListingResponse {
  const { queue, scheduler, store } = deps;
  return {
    store: path.resolve(eBaseDir(store.root)),
    activitySince: queue?.startedAt ?? null,
    triggers: triggerListing(
      loadTriggers(store.root, store.context()),
      (deps.now ?? (() => new Date()))(),
      {
        ...(queue ? { activity: id => queue.triggerActivity(id) } : {}),
        ...(scheduler ? { nextFireAt: id => scheduler.nextFireAt(id) } : {}),
      }
    ),
  };
}

export function triggersRoutes(deps: TriggersApiDeps): Router {
  const router = Router();
  router.get(TRIGGERS_PATH, (_request, response) => {
    respondJson(response, () => triggersResponse(deps));
  });
  return router;
}
