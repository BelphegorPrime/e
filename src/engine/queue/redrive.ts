/**
 * **`e trigger redrive <id>`'s mechanics** (ADR-0016 section 6): a dead
 * request back into `queue/`, human-only, as a fresh acceptance against the
 * declaration as it is now (see `core/trigger/redrive.ts`). Refused against a
 * deleted, broken or disabled trigger, and while its key is already pending -
 * naming the pending request. A refusal keeps the dead record; the dead file
 * goes only once the request is back in `queue/`, so nothing is ever lost
 * between the two.
 *
 * The request keeps its event, so its provenance names the original
 * delivery or tick; it gets a fresh id and `enqueuedAt`, so it queues behind
 * what is already waiting and gets a full TTL. A running `serve` claims it on
 * its next tick.
 */

import fs from 'node:fs';
import { redriveFire } from '../../core/trigger/redrive.js';
import { loadTrigger, type TriggerStore } from '../../core/trigger/load.js';
import { triggerConfigPath } from '../../core/store/paths.js';
import {
  newRequestId,
  pendingRequest,
  readDeadRequest,
  redriveRequest,
  type RunRequest,
  type RunsDirs,
} from './runsSpool.js';

export interface RedriveDeps {
  dirs: RunsDirs;
  store: TriggerStore;
  /** The queue's `maxLength`: a redrive does not jump a full queue. */
  maxLength: number;
  now?: () => Date;
}

export type RedriveResult =
  | { status: 'redriven'; request: RunRequest }
  | { status: 'refused'; reason: string };

export function redrive(deps: RedriveDeps, id: string): RedriveResult {
  const refuse = (reason: string): RedriveResult => ({
    status: 'refused',
    reason,
  });
  const dead = readDeadRequest(deps.dirs, id);
  if (!dead) return refuse(`no dead request ${id}`);
  const { request } = dead;
  const { root, context } = deps.store;
  if (!fs.existsSync(triggerConfigPath(request.trigger, root))) {
    return refuse(`trigger "${request.trigger}" was deleted`);
  }
  const loaded = loadTrigger(request.trigger, root, context());
  if (!loaded.trigger) {
    return refuse(
      `trigger "${request.trigger}" does not load: ${loaded.error}`
    );
  }
  if (!request.event) {
    return refuse(`${id} carries no event to accept again`);
  }
  const fire = redriveFire(loaded.trigger, {
    event: request.event,
    ...(request.payload !== undefined ? { payload: request.payload } : {}),
  });
  if ('dropped' in fire) return refuse(fire.dropped);

  const alreadyPending = (): RedriveResult | undefined => {
    const pending = pendingRequest(deps.dirs, fire.request.key);
    return pending
      ? refuse(
          `${fire.request.key} is already pending as ${pending.id}; it will run, and a redrive would only duplicate it`
        )
      : undefined;
  };
  const pending = alreadyPending();
  if (pending) return pending;
  // A fresh acceptance takes its place at the back of the queue: the queue
  // runs oldest id first, and the old id would jump every newer request.
  const redriven: RunRequest = {
    ...fire.request,
    id: newRequestId('trg'),
    event: request.event,
    ...(request.eventUrl !== undefined ? { eventUrl: request.eventUrl } : {}),
    enqueuedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  const result = redriveRequest(deps.dirs, id, redriven, deps.maxLength);
  switch (result.status) {
    case 'enqueued':
      return { status: 'redriven', request: redriven };
    case 'duplicate':
      // Lost a race with a fresh delivery since the check above.
      return alreadyPending() ?? refuse(`${redriven.key} is already pending`);
    case 'full':
      return refuse(`the queue is full (${deps.maxLength} waiting)`);
  }
}
