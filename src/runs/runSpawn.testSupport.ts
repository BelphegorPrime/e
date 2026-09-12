import type {
  ContainerRunner,
  RunOptions,
  SidecarSpec,
} from '../runtime/index.js';
import type { Harness } from '../harness/index.js';
import type { Agent } from '../agent/index.js';
import fs from 'node:fs';
import path from 'node:path';

/*
 * Test doubles for the run orchestrator, shared by the fake-driven and the
 * real-git run tests. Not a test file itself (the `*.test.js` glob skips it),
 * so importing it does not re-register another file's tests.
 */

/** A `ContainerRunner` fake that records the run and the group lifecycle. */
export class FakeRuntime implements ContainerRunner {
  ran = false;
  image?: string;
  options?: RunOptions;
  command?: string[];

  /** Ordered record of every group primitive called, for asserting lifecycle order. */
  calls: string[] = [];
  networks: string[] = [];
  removedNetworks: string[] = [];
  startedSidecars: SidecarSpec[] = [];
  removedContainers: string[] = [];
  sleeps: number[] = [];

  /**
   * Scripted probe results per container name: an array of booleans consumed one
   * per `probeTcp` call (last value repeats). Missing name → always true.
   */
  tcpScript: Record<string, boolean[]> = {};
  healthcheckResult = true;
  /** Container names reported as NOT running afterwards (a mid-run crash). */
  crashed: Set<string> = new Set();
  /** When set, the named group op throws (to test fail-fast / best-effort teardown). */
  throwOn?: {
    op: 'createNetwork' | 'removeNetwork' | 'removeContainer';
    message: string;
  };

  constructor(private exitCode = 0) {}

  /** Runs while the "container" runs: a test plays the agent here (e.g. posts a sibling request). */
  onRun?: (options: RunOptions) => void | Promise<void>;

  async run(
    image: string,
    options: RunOptions,
    command: string[]
  ): Promise<number> {
    this.calls.push('run');
    this.ran = true;
    this.image = image;
    this.options = options;
    this.command = command;
    if (this.onRun) await this.onRun(options);
    return this.exitCode;
  }

  createNetwork(name: string): void {
    this.calls.push('createNetwork');
    if (this.throwOn?.op === 'createNetwork')
      throw new Error(this.throwOn.message);
    this.networks.push(name);
  }
  removeNetwork(name: string): void {
    this.calls.push('removeNetwork');
    if (this.throwOn?.op === 'removeNetwork')
      throw new Error(this.throwOn.message);
    this.removedNetworks.push(name);
  }
  startSidecar(spec: SidecarSpec): void {
    this.calls.push('startSidecar');
    this.startedSidecars.push(spec);
  }
  removeContainer(name: string): void {
    this.calls.push('removeContainer');
    if (this.throwOn?.op === 'removeContainer')
      throw new Error(this.throwOn.message);
    this.removedContainers.push(name);
  }
  probedNetworks: string[] = [];
  probeTcp(network: string, host: string, _port: number): boolean {
    this.calls.push('probeTcp');
    this.probedNetworks.push(`${network} ${host}`);
    const script = this.tcpScript[host];
    if (!script || script.length === 0) return true;
    return script.length === 1 ? script[0] : (script.shift() as boolean);
  }
  probeHealthcheck(_container: string, _command: string[]): boolean {
    this.calls.push('probeHealthcheck');
    return this.healthcheckResult;
  }
  isRunning(name: string): boolean {
    this.calls.push('isRunning');
    return !this.crashed.has(name);
  }
  volumeExists(_volumeName: string): boolean {
    this.calls.push('volumeExists');
    return true;
  }
  createVolume(_volumeName: string): void {
    this.calls.push('createVolume');
  }
  copyVolumeToDir(_volumeName: string, _hostDir: string): void {
    this.calls.push('copyVolumeToDir');
  }
  copyDirToVolume(
    _hostDir: string,
    _volumeName: string,
    _wipe?: boolean
  ): void {
    this.calls.push('copyDirToVolume');
  }
}

/** A sleep spy that never actually waits, so readiness polling is instant in tests. */
export function makeSleep(runtime: FakeRuntime): (ms: number) => Promise<void> {
  return async (ms: number) => {
    runtime.sleeps.push(ms);
  };
}

/** A minimal one-shot harness: `demo -p <prompt>`, or the `demo` TUI. */
export const demoHarness: Harness = {
  name: 'demo',
  imageTag: 'e-harness-demo',
  dockerfile: { label: 'demo', npmPackage: 'demo' },
  requiredEnv: [],
  protocols: [],
  buildCommand: (prompt: string) => ['demo', '-p', prompt],
  buildInteractiveCommand: () => ['demo'],
};

/** The default agent for the demo harness (name mirrors the harness). */
export const demoAgent: Agent = { name: 'demo', harness: 'demo' };

/**
 * Seeds a parent worktree with a realistic `node_modules` (a package, a
 * relative `.bin` symlink) plus the things that must never travel into a
 * sibling: an env file and git metadata inside the tree, an env file at the
 * top. Leaves the top-level `.git` alone (a real worktree has one).
 */
export function seedParentArtifacts(parentWorktree: string): void {
  const nm = path.join(parentWorktree, 'node_modules');
  fs.mkdirSync(path.join(nm, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(nm, 'pkg', 'index.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(nm, '.bin'));
  fs.symlinkSync('../pkg/index.js', path.join(nm, '.bin', 'tool'));
  fs.writeFileSync(path.join(nm, 'pkg', '.env'), 'SECRET=1\n');
  fs.mkdirSync(path.join(nm, '.git'));
  fs.writeFileSync(path.join(nm, '.git', 'HEAD'), 'ref\n');
  fs.writeFileSync(path.join(parentWorktree, '.env'), 'TOP=secret\n');
}
