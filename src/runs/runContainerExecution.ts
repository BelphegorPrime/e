import type { ContainerRunner, RunOptions } from '../runtime/index.js';
import type { Harness } from '../harness/index.js';
import type { Agent } from '../agent/index.js';

/** Clean seam for container execution in runs. */
export interface ContainerExecutor {
  /** Execute a container with the given configuration. */
  execute(
    imageTag: string,
    runOptions: RunOptions,
    command: string[]
  ): Promise<{ exitCode: number; logs?: string }>;
}

/** Production container executor using runtime. */
export class ProductionContainerExecutor implements ContainerExecutor {
  constructor(private readonly runtime: ContainerRunner) {}

  async execute(
    imageTag: string,
    runOptions: RunOptions,
    command: string[]
  ): Promise<{ exitCode: number; logs?: string }> {
    const exitCode = await this.runtime.run(imageTag, runOptions, command);
    return { exitCode };
  }
}

/** In-memory container executor for testing. */
export class InMemoryContainerExecutor implements ContainerExecutor {
  private executionHistory: Array<{ imageTag: string; runOptions: RunOptions; command: string[]; exitCode: number }> = [];

  async execute(
    imageTag: string,
    runOptions: RunOptions,
    command: string[]
  ): Promise<{ exitCode: number; logs?: string }> {
    // Simulate execution for testing
    const exitCode = Math.random() > 0.5 ? 0 : 1; // 50% success rate
    this.executionHistory.push({ imageTag, runOptions, command, exitCode });
    return { exitCode };
  }

  getExecutionHistory(): Array<{ imageTag: string; runOptions: RunOptions; command: string[]; exitCode: number }> {
    return [...this.executionHistory];
  }
}