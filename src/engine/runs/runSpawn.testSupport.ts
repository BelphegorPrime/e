import type {
  ContainerRunner,
  RunOptions,
  SidecarSpec,
} from '../../ports/runtime/index.js';
import type { Harness } from '../../core/harness/index.js';
import type { Agent } from '../../core/agent/index.js';
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

  /** The engine name a child `e spawn` would inherit as `E_RUNTIME`. */
  engine = 'docker';
  /** Image tags handed to `build`, in order. */
  built: string[] = [];
  /** Compose files brought up, in order. */
  composedUp: string[] = [];
  /** What `imageExists` answers; false by default, so every build gate fires. */
  imageExistsResult = false;

  /** Ordered record of every group primitive called, for asserting lifecycle order. */
  calls: string[] = [];
  networks: string[] = [];
  removedNetworks: string[] = [];
  startedSidecars: SidecarSpec[] = [];
  removedContainers: string[] = [];
  /** Named volumes handed to `createVolume`, in order. */
  createdVolumes: string[] = [];
  /**
   * Every container run, in order - a run with a verify gate starts two (the
   * agent, then the check). The singular `image`/`options`/`command` above
   * stay the most recent one.
   */
  runs: { image: string; options: RunOptions; command: string[] }[] = [];
  /**
   * Exit codes consumed one per `run`, for a test that needs the agent and the
   * check to end differently; exhausted, it falls back to the constructor's.
   */
  exitCodes: number[] = [];
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

  imageExists(_imageTag: string): boolean {
    this.calls.push('imageExists');
    return this.imageExistsResult;
  }
  build(imageTag: string, _contextDir: string, _dockerfile?: string): void {
    this.calls.push('build');
    this.built.push(imageTag);
  }
  composeUp(
    composeFile: string,
    _envFile?: string,
    _waitForBootstrap?: boolean
  ): void {
    this.calls.push('composeUp');
    this.composedUp.push(composeFile);
  }

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
    this.runs.push({ image, options, command });
    if (this.onRun) await this.onRun(options);
    return this.exitCodes.length > 0
      ? (this.exitCodes.shift() as number)
      : this.exitCode;
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
  createVolume(volumeName: string): void {
    this.calls.push('createVolume');
    this.createdVolumes.push(volumeName);
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

/**
 * A sleep spy that records the requested wait instead of serving it, so
 * readiness polling is instant in tests.
 *
 * It still **yields to the event loop** once per call. Resolving as a bare
 * microtask - which is what an `async` function with no `await` does - lets a
 * tight poll loop (tick, sleep, tick, sleep) monopolise the microtask queue,
 * so timers and socket callbacks in the same test never run and anything
 * doing real I/O alongside the loop hangs forever. `setImmediate` costs
 * nothing in wall-clock terms and hands control back between polls.
 */
export function makeSleep(runtime: FakeRuntime): (ms: number) => Promise<void> {
  return (ms: number) =>
    new Promise<void>(resolve => {
      runtime.sleeps.push(ms);
      setImmediate(resolve);
    });
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
