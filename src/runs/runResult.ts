import type { Git } from './git/index.js';

/** Clean seam for run result management in runs. */
export interface RunResult {
  /** Create a successful run result. */
  success(options: {
    ran: boolean;
    exitCode: number;
    captured?: boolean;
    branch?: string;
    pushed?: boolean;
    pushWarning?: string;
    pullRequestUrl?: string;
    pullRequestWarning?: string;
    sidecarWarnings?: string[];
  }): RunSpawnResult;

  /** Create a failed run result. */
  failure(options: {
    error: string;
  }): RunSpawnResult;
}

/** Production run result implementation. */
export class ProductionRunResult implements RunResult {
  async success(options: {
    ran: boolean;
    exitCode: number;
    captured?: boolean;
    branch?: string;
    pushed?: boolean;
    pushWarning?: string;
    pullRequestUrl?: string;
    pullRequestWarning?: string;
    sidecarWarnings?: string[];
  }): RunSpawnResult {
    return {
      ran: options.ran,
      exitCode: options.exitCode,
      captured: options.captured,
      branch: options.branch,
      pushed: options.pushed,
      pushWarning: options.pushWarning,
      pullRequestUrl: options.pullRequestUrl,
      pullRequestWarning: options.pullRequestWarning,
      sidecarWarnings: options.sidecarWarnings ?? [],
    };
  }

  async failure(options: {
    error: string;
  }): RunSpawnResult {
    return {
      ran: false,
      exitCode: 1,
      error: options.error,
      sidecarWarnings: [],
    };
  }
}

/** In-memory run result for testing. */
export class InMemoryRunResult implements RunResult {
  private results: RunSpawnResult[] = [];

  async success(options: {
    ran: boolean;
    exitCode: number;
    captured?: boolean;
    branch?: string;
    pushed?: boolean;
    pushWarning?: string;
    pullRequestUrl?: string;
    pullRequestWarning?: string;
    sidecarWarnings?: string[];
  }): RunSpawnResult {
    const result = {
      ran: options.ran,
      exitCode: options.exitCode,
      captured: options.captured,
      branch: options.branch,
      pushed: options.pushed,
      pushWarning: options.pushWarning,
      pullRequestUrl: options.pullRequestUrl,
      pullRequestWarning: options.pullRequestWarning,
      sidecarWarnings: options.sidecarWarnings ?? [],
    };
    this.results.push(result);
    return result;
  }

  async failure(options: {
    error: string;
  }): RunSpawnResult {
    const result = {
      ran: false,
      exitCode: 1,
      error: options.error,
      sidecarWarnings: [],
    };
    this.results.push(result);
    return result;
  }

  getLastResult(): RunSpawnResult | undefined {
    return this.results[this.results.length - 1];
  }

  getResults(): RunSpawnResult[] {
    return [...this.results];
  }
}