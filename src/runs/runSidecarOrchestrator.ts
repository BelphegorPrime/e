import type { ContainerRunner, SidecarSpec } from './runtime/index.js';

/** Clean seam for sidecar orchestration and readiness management. */
export interface SidecarOrchestrator {
  /** Start a sidecar container and track it. */
  startSidecar(spec: SidecarSpec): Promise<void>;
  /** Check if a sidecar is ready (port open + healthcheck passes). */
  isSidecarReady(spec: SidecarSpec): boolean;
  /** Wait for sidecar readiness with polling. */
  awaitSidecarReady(
    spec: SidecarSpec,
    opts: ReadinessPolicy & { sleep: (ms: number) => Promise<void> }
  ): Promise<boolean>;
  /** Stop and remove a sidecar. */
  stopSidecar(spec: SidecarSpec): Promise<void>;
}

/** In-memory sidecar orchestrator for testing. */
export class InMemorySidecarOrchestrator implements SidecarOrchestrator {
  private startedSidecars = new Map<string, SidecarSpec>();

  async startSidecar(spec: SidecarSpec): Promise<void> {
    this.startedSidecars.set(spec.name, spec);
  }

  isSidecarReady(spec: SidecarSpec): boolean {
    // Simulate readiness for testing
    return this.startedSidecars.has(spec.name);
  }

  async awaitSidecarReady(
    spec: SidecarSpec,
    opts: ReadinessPolicy & { sleep: (ms: number) => Promise<void> }
  ): Promise<boolean> {
    // Simulate readiness for testing
    return this.isSidecarReady(spec);
  }

  async stopSidecar(spec: SidecarSpec): Promise<void> {
    this.startedSidecars.delete(spec.name);
  }
}

/** Docker runtime sidecar orchestrator for production. */
export class DockerSidecarOrchestrator implements SidecarOrchestrator {
  constructor(private readonly runner: ContainerRunner) {}

  async startSidecar(spec: SidecarSpec): Promise<void> {
    await this.runner.startSidecar(spec);
  }

  isSidecarReady(spec: SidecarSpec): boolean {
    return this.runner.isSidecarReady(spec);
  }

  async awaitSidecarReady(
    spec: SidecarSpec,
    opts: ReadinessPolicy & { sleep: (ms: number) => Promise<void> }
  ): Promise<boolean> {
    const { attempts, intervalMs, sleep } = opts;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.isSidecarReady(spec)) return true;
      if (attempt < attempts - 1) await sleep(intervalMs);
    }
    return false;
  }

  async stopSidecar(spec: SidecarSpec): Promise<void> {
    await this.runner.stopSidecar(spec.name);
  }
}

/** High-level sidecar management with error handling. */
export class SidecarManager {
  constructor(private readonly orchestrator: SidecarOrchestrator) {}

  async startAll(specs: SidecarSpec[]): Promise<void> {
    await Promise.all(specs.map(spec => this.orchestrator.startSidecar(spec)));
  }

  async waitForAllReady(
    specs: SidecarSpec[],
    opts: ReadinessPolicy & { sleep: (ms: number) => Promise<void> }
  ): Promise<{ ready: SidecarSpec[]; notReady: SidecarSpec[] }> {
    const ready: SidecarSpec[] = [];
    const notReady: SidecarSpec[] = [];

    for (const spec of specs) {
      const isReady = await this.orchestrator.awaitSidecarReady(spec, opts);
      if (isReady) ready.push(spec);
      else notReady.push(spec);
    }

    return { ready, notReady };
  }

  async stopAll(specs: SidecarSpec[]): Promise<void> {
    await Promise.all(specs.map(spec => this.orchestrator.stopSidecar(spec)));
  }
}