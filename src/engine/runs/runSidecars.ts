/**
 * **Sidecar readiness.** A Run's Sidecars are started detached and then polled
 * until each answers, because a container that exists is not yet a container
 * that serves. The two decisions that live here - what "ready" means for one
 * Sidecar, and how long a Run waits for all of them - are the only behaviour
 * the Run orchestration needs; starting and stopping are single `ContainerRunner`
 * calls it makes itself.
 */

import type {
  ContainerRunner,
  SidecarSpec,
} from '../../ports/runtime/index.js';

/** How readiness polling is paced: how many probe attempts, and the wait between them. */
export interface ReadinessPolicy {
  attempts: number;
  intervalMs: number;
}

/** Result of a batched readiness wait. */
export interface ReadinessResult {
  ready: SidecarSpec[];
  notReady: SidecarSpec[];
}

/** True if the Sidecar's port is accepting connections and its healthcheck passes. */
export function isSidecarReady(
  runner: ContainerRunner,
  spec: SidecarSpec
): boolean {
  // In a shared netns the sidecar has no alias of its own: it is reached on
  // that namespace's loopback, so probe from inside the same namespace.
  const portOpen = spec.netns
    ? runner.probeTcp(`container:${spec.netns}`, '127.0.0.1', spec.port)
    : runner.probeTcp(spec.network ?? '', spec.alias, spec.port);
  if (!portOpen) return false;
  if (spec.healthcheck && spec.healthcheck.length > 0) {
    return runner.probeHealthcheck(spec.name, spec.healthcheck);
  }
  return true;
}

/**
 * Waits for every Sidecar to become ready (polling at `opts.intervalMs` up to
 * `opts.attempts` times). Never throws: Sidecars that never came up are
 * reported in `notReady` for the caller to tear down.
 */
export async function waitForAllReady(
  runner: ContainerRunner,
  specs: SidecarSpec[],
  opts: ReadinessPolicy & { sleep: (ms: number) => Promise<void> }
): Promise<ReadinessResult> {
  const ready: SidecarSpec[] = [];
  const notReady: SidecarSpec[] = [];
  for (const spec of specs) {
    let ok = false;
    for (let attempt = 0; attempt < opts.attempts && !ok; attempt++) {
      if (isSidecarReady(runner, spec)) {
        ok = true;
      } else {
        await opts.sleep(opts.intervalMs);
      }
    }
    if (ok) ready.push(spec);
    else notReady.push(spec);
  }
  return { ready, notReady };
}
