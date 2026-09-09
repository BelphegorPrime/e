import type { ContainerRunner } from '../runtime/index.js';

/** Clean seam for capturing run logs. */
export interface LogCapture {
  /** Capture logs for a run. */
  captureEgressLogs(runner: ContainerRunner, storeRoot: string, branch: string): Promise<void>;
}

/** Production log capture implementation. */
export class ProductionLogCapture implements LogCapture {
  async captureEgressLogs(runner: ContainerRunner, storeRoot: string, branch: string): Promise<void> {
    // Implementation for capturing logs
  }
}
