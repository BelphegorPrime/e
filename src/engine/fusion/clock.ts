/**
 * **The coordinator's clock**: the one wait a fusion does - between polls,
 * until a retry's backoff is over, until a deadline - behind a seam, so tests
 * drive it with an injected clock instead of real time.
 */

import { MAX_TIMEOUT_MS } from '../../core/fusion/profile.js';

/**
 * Waits `ms`, or less when `signal` aborts first; never rejects. Production
 * uses a timer; a test advances its own clock and returns.
 */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** A timer, cleared as soon as the wait is cut short; waits past a timer's reach are cut to it. */
export const realSleep: Sleep = (ms, signal) =>
  new Promise(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, Math.min(ms, MAX_TIMEOUT_MS)));
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * Resolves `true` once `now()` reaches `at` (epoch ms), or `false` as soon as
 * `stop` aborts. Re-checks the clock after every wait, so a long deadline is
 * reached in timer-sized steps and a clock that jumps is honoured.
 */
export async function untilTime(
  at: number,
  clock: { now: () => Date; sleep: Sleep },
  stop: AbortSignal
): Promise<boolean> {
  for (;;) {
    if (stop.aborted) return false;
    const left = at - clock.now().getTime();
    if (left <= 0) return true;
    await clock.sleep(left, stop);
  }
}

/**
 * The fan-out loop's one wake-up source: a sleep that a child's exit or a
 * cancel ends early. One pending sleep at a time, and each child adds exactly
 * one reaction for its whole life, however long the fan-out polls. A wake
 * that lands while the loop is between sleeps is kept, so the next sleep
 * returns at once rather than missing it.
 */
export class Waker {
  private pending?: AbortController;
  private woken = false;

  constructor(private readonly sleeper: Sleep = realSleep) {}

  wake(): void {
    if (this.pending) this.pending.abort();
    else this.woken = true;
  }

  async sleep(ms: number): Promise<void> {
    if (this.woken) {
      this.woken = false;
      return;
    }
    const controller = new AbortController();
    this.pending = controller;
    try {
      await this.sleeper(ms, controller.signal);
    } finally {
      if (this.pending === controller) this.pending = undefined;
    }
  }
}
