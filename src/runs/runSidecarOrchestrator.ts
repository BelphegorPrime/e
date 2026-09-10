import type { ContainerRunner, SidecarSpec } from '../runtime/index.js';

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

/** Clean seam for sidecar orchestration and readiness management. */
export interface SidecarOrchestrator {
  /** Start all sidecars (detached on their network). */
  startAll(specs: SidecarSpec[]): Promise<void>;
  /** Stop and remove all sidecars (best-effort teardown). */
  stopAll(specs: SidecarSpec[]): Promise<void>;
  /** True if the sidecar's port is accepting connections and its healthcheck passes. */
  isSidecarReady(spec: SidecarSpec): boolean;
  /**
   * Wait for every sidecar to become ready (polling at `opts.intervalMs` up to
   * `opts.attempts` times). Never throws: sidecars that never came up are
   * reported in `notReady`.
   */
  waitForAllReady(
    specs: SidecarSpec[],
    opts: ReadinessPolicy & { sleep: (ms: number) => Promise<void> }
  ): Promise<ReadinessResult>;
}

/** In-memory sidecar orchestrator for testing. */
export class InMemorySidecarOrchestrator implements SidecarOrchestrator {
  private startedSidecars = new Map<string, SidecarSpec>();

  async startAll(specs: SidecarSpec[]): Promise<void> {
    for (const spec of specs) this.startedSidecars.set(spec.name, spec);
  }

  async stopAll(specs: SidecarSpec[]): Promise<void> {
    for (const spec of specs) this.startedSidecars.delete(spec.name);
  }

  isSidecarReady(spec: SidecarSpec): boolean {
    return this.startedSidecars.has(spec.name);
  }

  async waitForAllReady(
    specs: SidecarSpec[],
    _opts: ReadinessPolicy & { sleep: (ms: number) => Promise<void> }
  ): Promise<ReadinessResult> {
    const ready = specs.filter(spec => this.isSidecarReady(spec));
    const notReady = specs.filter(spec => !this.isSidecarReady(spec));
    return { ready, notReady };
  }
}

/** Docker runtime sidecar orchestrator for production. */
export class DockerSidecarOrchestrator implements SidecarOrchestrator {
  constructor(private readonly runner: ContainerRunner) {}

  async startAll(specs: SidecarSpec[]): Promise<void> {
    for (const spec of specs) this.runner.startSidecar(spec);
  }

  async stopAll(specs: SidecarSpec[]): Promise<void> {
    for (const spec of specs) this.runner.removeContainer(spec.name);
  }

  isSidecarReady(spec: SidecarSpec): boolean {
    const portOpen = this.runner.probeTcp(
      spec.network ?? '',
      spec.alias,
      spec.port
    );
    if (!portOpen) return false;
    if (spec.healthcheck && spec.healthcheck.length > 0) {
      return this.runner.probeHealthcheck(spec.name, spec.healthcheck);
    }
    return true;
  }

  async waitForAllReady(
    specs: SidecarSpec[],
    opts: ReadinessPolicy & { sleep: (ms: number) => Promise<void> }
  ): Promise<ReadinessResult> {
    const ready: SidecarSpec[] = [];
    const notReady: SidecarSpec[] = [];
    for (const spec of specs) {
      let ok = false;
      for (let attempt = 0; attempt < opts.attempts && !ok; attempt++) {
        if (this.isSidecarReady(spec)) {
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
}
