import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import type { Git, WorktreeSpec } from './git/index';
import type { ContainerRunner, RunOptions, SidecarSpec } from './runtime/index';
import type { Harness } from './harness/index';
import type { Agent } from './agent';
import {
  runSpawn,
  type RunSpawnDeps,
  type RunSpawnParams,
  type SidecarPlan,
} from './runSpawn';
import { slugify } from './slugify';

/** A `Git` fake that records what the orchestrator asked it to do. */
class FakeGit implements Git {
  repo: boolean;
  dirty: boolean;
  hasCommits: boolean;
  existingBranches: string[];
  /** Branch names that throw on `addWorktree` (simulating a create collision). */
  collideBranches: Set<string>;
  /** When set, every `addWorktree` throws with this (non-collision) message. */
  addWorktreeError?: string;
  /** When set, `push` throws with this message. */
  pushFails?: string;

  calls: string[] = [];
  listedPrefixes: string[] = [];
  worktrees: WorktreeSpec[] = [];
  removed: string[] = [];
  commits: { path: string; message: string }[] = [];
  pushed: string[] = [];

  constructor(
    opts: {
      repo?: boolean;
      dirty?: boolean;
      hasCommits?: boolean;
      existingBranches?: string[];
      collideBranches?: string[];
      addWorktreeError?: string;
      pushFails?: string;
    } = {}
  ) {
    this.repo = opts.repo ?? true;
    this.dirty = opts.dirty ?? false;
    this.hasCommits = opts.hasCommits ?? true;
    this.existingBranches = opts.existingBranches ?? [];
    this.collideBranches = new Set(opts.collideBranches ?? []);
    this.addWorktreeError = opts.addWorktreeError;
    this.pushFails = opts.pushFails;
  }

  isRepo(): boolean {
    this.calls.push('isRepo');
    return this.repo;
  }
  headSha(): string {
    this.calls.push('headSha');
    return 'basesha';
  }
  listRunBranches(prefix: string): string[] {
    this.calls.push('listRunBranches');
    this.listedPrefixes.push(prefix);
    return this.existingBranches;
  }
  addWorktree(spec: WorktreeSpec): void {
    this.calls.push('addWorktree');
    if (this.addWorktreeError) throw new Error(this.addWorktreeError);
    if (this.collideBranches.has(spec.branch)) {
      throw new Error(`branch ${spec.branch} already exists`);
    }
    this.worktrees.push(spec);
  }
  isDirty(): boolean {
    this.calls.push('isDirty');
    return this.dirty;
  }
  commitAll(worktreePath: string, message: string): void {
    this.calls.push('commitAll');
    this.commits.push({ path: worktreePath, message });
  }
  hasCommitsBeyondBase(): boolean {
    this.calls.push('hasCommitsBeyondBase');
    return this.hasCommits;
  }
  push(branch: string): void {
    this.calls.push('push');
    if (this.pushFails) throw new Error(this.pushFails);
    this.pushed.push(branch);
  }
  removeWorktree(worktreePath: string): void {
    this.calls.push('removeWorktree');
    this.removed.push(worktreePath);
  }
}

/** A `ContainerRunner` fake that records the run and the group lifecycle. */
class FakeRuntime implements ContainerRunner {
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
  probeTcp(_network: string, host: string, _port: number): boolean {
    this.calls.push('probeTcp');
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
}

/** A sleep spy that never actually waits, so readiness polling is instant in tests. */
function makeSleep(runtime: FakeRuntime): (ms: number) => Promise<void> {
  return async (ms: number) => {
    runtime.sleeps.push(ms);
  };
}

const harness: Harness = {
  name: 'demo',
  imageTag: 'e-harness-demo',
  dockerfile: { label: 'demo', npmPackage: 'demo' },
  requiredEnv: [],
  protocols: [],
  buildCommand: (prompt: string) => ['demo', '-p', prompt],
  buildInteractiveCommand: () => ['demo'],
};

/** The default agent for the demo harness (name mirrors the harness). */
const agent: Agent = { name: 'demo', harness: 'demo' };

function makeDeps(overrides: Partial<RunSpawnDeps> = {}) {
  const git = overrides.git ?? new FakeGit();
  const runtime = (overrides.runtime ?? new FakeRuntime()) as FakeRuntime;
  const deps: RunSpawnDeps = {
    git,
    runtime,
    // Instant, recorded sleep so readiness polling never actually waits.
    sleep: overrides.sleep ?? makeSleep(runtime),
  };
  return { deps, git: git as FakeGit, runtime };
}

function makeParams(overrides: Partial<RunSpawnParams> = {}): RunSpawnParams {
  return {
    agent,
    harness,
    prompt: 'Fix the flaky test',
    imageTag: 'e-harness-demo',
    runOptions: { attach: true, rm: true, rmWorktree: true },
    worktreesDir: '/tmp/e-worktrees',
    ...overrides,
  };
}

/** A demo sidecar plan; a few fast readiness attempts keep the tests instant. */
const sidecar: SidecarPlan = {
  alias: 'everything',
  image: 'e-mcp-everything',
  port: 3001,
};
const fastReadiness = { attempts: 3, intervalMs: 1 };

test('creates a worktree from HEAD on branch e/<harness>/<slug>-1 and runs the harness', async () => {
  const { deps, git, runtime } = makeDeps();
  const result = await runSpawn(deps, makeParams());

  const slug = slugify('Fix the flaky test');
  assert.equal(git.worktrees.length, 1);
  assert.equal(git.worktrees[0].branch, `e/demo/${slug}-1`);
  assert.equal(git.worktrees[0].base, 'basesha');

  assert.equal(runtime.ran, true);
  assert.equal(runtime.image, 'e-harness-demo');
  assert.equal(runtime.options?.workdir, '/workspace');
  assert.deepEqual(runtime.options?.volumes, [
    { host: git.worktrees[0].path, container: '/workspace' },
  ]);
  assert.deepEqual(runtime.command, ['demo', '-p', 'Fix the flaky test']);

  assert.equal(result.ran, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.branch, `e/demo/${slug}-1`);
});

test('the run branch uses the agent name, while the image stays the harness image', async () => {
  const { deps, git, runtime } = makeDeps();
  const smart: Agent = { name: 'smart-demo', harness: 'demo' };
  const result = await runSpawn(deps, makeParams({ agent: smart }));

  const slug = slugify('Fix the flaky test');
  assert.equal(result.branch, `e/smart-demo/${slug}-1`);
  assert.equal(git.listedPrefixes[0], `e/smart-demo/${slug}`);
  // The run executes the imageTag it was given (the harness base here).
  assert.equal(runtime.image, 'e-harness-demo');
});

test('runs the imageTag it is given (e.g. a derived agent image)', async () => {
  const { deps, runtime } = makeDeps();
  await runSpawn(deps, makeParams({ imageTag: 'e-agent-smart-codex' }));
  assert.equal(runtime.image, 'e-agent-smart-codex');
});

test('threads a runtime-resolved model into the harness command', async () => {
  const { deps, runtime } = makeDeps();
  // A harness that takes the model as a command flag (like Codex `-m`).
  const codexish: Harness = {
    ...harness,
    buildCommand: (prompt, model) =>
      model
        ? ['codex', 'exec', '-m', model, prompt]
        : ['codex', 'exec', prompt],
  };
  await runSpawn(deps, makeParams({ harness: codexish, model: 'gpt-5-codex' }));
  assert.deepEqual(runtime.command, [
    'codex',
    'exec',
    '-m',
    'gpt-5-codex',
    'Fix the flaky test',
  ]);
});

test('interactive mode starts the harness TUI and ignores the one-shot prompt', async () => {
  const { deps, runtime } = makeDeps();
  const interactiveHarness: Harness = {
    ...harness,
    buildInteractiveCommand: model =>
      model ? ['demo', 'tui', '-m', model] : ['demo', 'tui'],
  };

  await runSpawn(
    deps,
    makeParams({
      harness: interactiveHarness,
      interactive: true,
      model: 'demo-pro',
    })
  );

  assert.deepEqual(runtime.command, ['demo', 'tui', '-m', 'demo-pro']);
});

test('does not modify the working tree in place: worktree lives under worktreesDir', async () => {
  const { deps, git } = makeDeps();
  await runSpawn(deps, makeParams({ worktreesDir: '/tmp/wt' }));
  assert.ok(git.worktrees[0].path.startsWith(`/tmp/wt${path.sep}`));
});

test('commits when the worktree is dirty', async () => {
  const { deps, git } = makeDeps({ git: new FakeGit({ dirty: true }) });
  await runSpawn(deps, makeParams());
  assert.equal(git.commits.length, 1);
  assert.equal(git.commits[0].path, git.worktrees[0].path);
});

test('leaves the agent commits alone when the worktree is clean', async () => {
  const { deps, git } = makeDeps({ git: new FakeGit({ dirty: false }) });
  await runSpawn(deps, makeParams());
  assert.equal(git.commits.length, 0);
});

test('always removes the worktree and keeps the branch, even on a clean exit-0 run', async () => {
  const { deps, git } = makeDeps();
  await runSpawn(deps, makeParams());
  assert.deepEqual(git.removed, [git.worktrees[0].path]);
});

test('removes the worktree even when the agent exits non-zero, and preserves the exit code', async () => {
  const { deps, git } = makeDeps({ runtime: new FakeRuntime(2) });
  const result = await runSpawn(deps, makeParams());
  assert.equal(result.exitCode, 2);
  assert.deepEqual(git.removed, [git.worktrees[0].path]);
  assert.equal(git.commits.length, 0);
});

test('--name overrides the slug and flows into the branch', async () => {
  const { deps, git } = makeDeps();
  const result = await runSpawn(deps, makeParams({ name: 'my-custom-run' }));
  assert.equal(git.worktrees[0].branch, 'e/demo/my-custom-run-1');
  assert.equal(result.branch, 'e/demo/my-custom-run-1');
});

test('numbers the run from the next counter after existing branches', async () => {
  const slug = slugify('Fix the flaky test');
  const { deps, git } = makeDeps({
    git: new FakeGit({
      existingBranches: [`e/demo/${slug}-1`, `e/demo/${slug}-2`],
    }),
  });
  const result = await runSpawn(deps, makeParams());
  assert.equal(git.listedPrefixes[0], `e/demo/${slug}`);
  assert.equal(result.branch, `e/demo/${slug}-3`);
});

test('counter considers remote-tracking branches', async () => {
  const slug = slugify('Fix the flaky test');
  const { deps } = makeDeps({
    git: new FakeGit({ existingBranches: [`origin/e/demo/${slug}-4`] }),
  });
  const result = await runSpawn(deps, makeParams());
  assert.equal(result.branch, `e/demo/${slug}-5`);
});

test('bumps the counter and retries on an atomic-create collision', async () => {
  const slug = slugify('Fix the flaky test');
  const { deps, git } = makeDeps({
    // A concurrent spawn already took -1 between our enumeration and create.
    git: new FakeGit({ collideBranches: [`e/demo/${slug}-1`] }),
  });
  const result = await runSpawn(deps, makeParams());

  assert.equal(result.branch, `e/demo/${slug}-2`);
  assert.equal(git.worktrees.length, 1);
  assert.equal(git.worktrees[0].branch, `e/demo/${slug}-2`);
  assert.equal(git.calls.filter(c => c === 'addWorktree').length, 2);
});

test('rethrows a non-collision worktree failure immediately without retrying', async () => {
  const { deps, git } = makeDeps({
    git: new FakeGit({ addWorktreeError: 'fatal: permission denied' }),
  });
  await assert.rejects(runSpawn(deps, makeParams()), /permission denied/);
  // Exactly one attempt — no counter-bump storm on a genuine error.
  assert.equal(git.calls.filter(c => c === 'addWorktree').length, 1);
});

test('pushes the branch to origin when the run exits 0 with commits', async () => {
  const { deps, git } = makeDeps();
  const result = await runSpawn(deps, makeParams());
  assert.deepEqual(git.pushed, [result.branch]);
  assert.equal(result.pushed, true);
});

test('does not push when the run exits non-zero', async () => {
  const { deps, git } = makeDeps({ runtime: new FakeRuntime(1) });
  const result = await runSpawn(deps, makeParams());
  assert.equal(git.pushed.length, 0);
  assert.ok(!git.calls.includes('push'));
  assert.equal(result.pushed, false);
});

test('does not push when the run exits 0 but produced no commits', async () => {
  const { deps, git } = makeDeps({ git: new FakeGit({ hasCommits: false }) });
  const result = await runSpawn(deps, makeParams());
  assert.equal(git.pushed.length, 0);
  assert.equal(result.pushed, false);
});

test('a push failure is non-fatal: branch kept, warning surfaced, exit code unchanged', async () => {
  const { deps, git } = makeDeps({
    git: new FakeGit({ pushFails: 'no configured remote' }),
  });
  const result = await runSpawn(deps, makeParams());

  assert.equal(result.exitCode, 0);
  assert.equal(result.pushed, false);
  assert.match(result.pushWarning ?? '', /no configured remote/);
  assert.equal(git.pushed.length, 0);
  // The worktree is still cleaned up and the branch (locally) preserved.
  assert.deepEqual(git.removed, [git.worktrees[0].path]);
});

// --- Composed run group (ADR-0005 / issue #13) ---------------------------------

test('regression: with no sidecars the run behaves exactly as before (no group calls)', async () => {
  const { deps, runtime } = makeDeps();
  const result = await runSpawn(deps, makeParams());

  assert.equal(result.ran, true);
  assert.equal(result.exitCode, 0);
  assert.equal(runtime.options?.network, undefined);
  assert.deepEqual(runtime.calls, ['run']);
  assert.equal(runtime.networks.length, 0);
  assert.equal(runtime.startedSidecars.length, 0);
  assert.equal(result.sidecarWarnings, undefined);
});

test('brings up the group in order: network → sidecar → probe → agent → teardown', async () => {
  const { deps, git, runtime } = makeDeps();
  await runSpawn(
    deps,
    makeParams({ sidecars: [sidecar], readiness: fastReadiness })
  );

  assert.deepEqual(runtime.calls, [
    'createNetwork',
    'startSidecar',
    'probeTcp',
    'run',
    'isRunning',
    'removeContainer',
    'removeNetwork',
  ]);
  // Teardown order and identifiers.
  const runName = git.worktrees[0].branch.replace(/\//g, '-');
  assert.deepEqual(runtime.networks, [`${runName}-net`]);
  assert.deepEqual(runtime.removedNetworks, [`${runName}-net`]);
  assert.deepEqual(runtime.removedContainers, [`${runName}-mcp-everything`]);
});

test('the agent joins the run network and the sidecar gets a unique name + alias', async () => {
  const { deps, git, runtime } = makeDeps();
  await runSpawn(
    deps,
    makeParams({ sidecars: [sidecar], readiness: fastReadiness })
  );
  const runName = git.worktrees[0].branch.replace(/\//g, '-');

  assert.equal(runtime.options?.network, `${runName}-net`);
  const spec = runtime.startedSidecars[0];
  assert.equal(spec.name, `${runName}-mcp-everything`);
  assert.equal(spec.alias, 'everything');
  assert.equal(spec.network, `${runName}-net`);
  assert.equal(spec.image, 'e-mcp-everything');
});

test('appends the harness MCP args to the container command', async () => {
  const { deps, runtime } = makeDeps();
  const mcpArgs = ['--mcp-config', '{"mcpServers":{}}'];
  await runSpawn(
    deps,
    makeParams({ sidecars: [sidecar], mcpArgs, readiness: fastReadiness })
  );
  assert.deepEqual(runtime.command, [
    'demo',
    '-p',
    'Fix the flaky test',
    '--mcp-config',
    '{"mcpServers":{}}',
  ]);
});

test('waits across retries: probe fails twice then succeeds, agent then runs', async () => {
  const { deps, runtime } = makeDeps();
  runtime.tcpScript = { everything: [false, false, true] };
  const result = await runSpawn(
    deps,
    makeParams({
      sidecars: [sidecar],
      readiness: { attempts: 5, intervalMs: 10 },
    })
  );

  assert.equal(result.ran, true);
  assert.equal(runtime.ran, true);
  // Two failed probes → slept exactly twice before the third succeeded.
  assert.deepEqual(runtime.sleeps, [10, 10]);
});

test('readiness miss aborts before the agent: no run, no commit, no push, group torn down', async () => {
  const { deps, git, runtime } = makeDeps();
  runtime.tcpScript = { everything: [false] }; // never ready
  const result = await runSpawn(
    deps,
    makeParams({ sidecars: [sidecar], readiness: fastReadiness })
  );

  assert.equal(result.ran, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.error ?? '', /everything/);
  assert.equal(runtime.ran, false);
  assert.ok(!git.calls.includes('commitAll'));
  assert.ok(!git.calls.includes('push'));
  // The whole group is still torn down, including the worktree.
  assert.deepEqual(runtime.removedContainers, [
    git.worktrees[0].branch.replace(/\//g, '-') + '-mcp-everything',
  ]);
  assert.equal(runtime.removedNetworks.length, 1);
  assert.deepEqual(git.removed, [git.worktrees[0].path]);
});

test('readiness requires the healthcheck too: port open but healthcheck failing → miss', async () => {
  const { deps, runtime } = makeDeps();
  runtime.healthcheckResult = false;
  const withHealth: SidecarPlan = { ...sidecar, healthcheck: ['true'] };
  const result = await runSpawn(
    deps,
    makeParams({ sidecars: [withHealth], readiness: fastReadiness })
  );

  assert.equal(result.ran, false);
  assert.equal(runtime.ran, false);
  assert.ok(runtime.calls.includes('probeHealthcheck'));
});

test('createNetwork failure aborts fail-fast: no sidecar started, no agent, worktree torn down', async () => {
  const { deps, git, runtime } = makeDeps();
  runtime.throwOn = { op: 'createNetwork', message: 'network create denied' };
  await assert.rejects(
    runSpawn(
      deps,
      makeParams({ sidecars: [sidecar], readiness: fastReadiness })
    ),
    /network create denied/
  );
  assert.equal(runtime.startedSidecars.length, 0);
  assert.equal(runtime.ran, false);
  // The worktree existed by then, so it is still removed in the finally.
  assert.deepEqual(git.removed, [git.worktrees[0].path]);
});

test('a mid-run sidecar crash is non-fatal: warning surfaced, run still succeeds and pushes', async () => {
  const { deps, runtime } = makeDeps();
  const runName = `e-demo-${slugify('Fix the flaky test')}-1`;
  runtime.crashed.add(`${runName}-mcp-everything`);

  const result = await runSpawn(
    deps,
    makeParams({ sidecars: [sidecar], readiness: fastReadiness })
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.ran, true);
  assert.equal(result.sidecarWarnings?.length, 1);
  assert.match(result.sidecarWarnings![0], /everything/);
  assert.equal(result.pushed, true);
});

test('a healthy sidecar produces no warning', async () => {
  const { deps, runtime } = makeDeps();
  const result = await runSpawn(
    deps,
    makeParams({ sidecars: [sidecar], readiness: fastReadiness })
  );
  assert.equal(runtime.calls.includes('isRunning'), true);
  assert.equal(result.sidecarWarnings, undefined);
});

test('tears the group down even when the agent exits non-zero', async () => {
  const { deps, git, runtime } = makeDeps({ runtime: new FakeRuntime(2) });
  const result = await runSpawn(
    deps,
    makeParams({ sidecars: [sidecar], readiness: fastReadiness })
  );
  assert.equal(result.exitCode, 2);
  assert.equal(runtime.removedContainers.length, 1);
  assert.equal(runtime.removedNetworks.length, 1);
  assert.deepEqual(git.removed, [git.worktrees[0].path]);
});

test('best-effort teardown never masks the run result when removal throws', async () => {
  const { deps, runtime } = makeDeps();
  runtime.throwOn = { op: 'removeContainer', message: 'rm boom' };
  const result = await runSpawn(
    deps,
    makeParams({ sidecars: [sidecar], readiness: fastReadiness })
  );
  // The run itself succeeded; the throwing teardown is swallowed.
  assert.equal(result.ran, true);
  assert.equal(result.exitCode, 0);
});

test('supports multiple sidecars: both started, both probed, both removed', async () => {
  const { deps, git, runtime } = makeDeps();
  const fs: SidecarPlan = {
    alias: 'filesystem',
    image: 'e-mcp-filesystem',
    port: 8000,
  };
  await runSpawn(
    deps,
    makeParams({ sidecars: [sidecar, fs], readiness: fastReadiness })
  );
  assert.equal(runtime.startedSidecars.length, 2);
  assert.equal(runtime.removedContainers.length, 2);
  const runName = git.worktrees[0].branch.replace(/\//g, '-');
  assert.deepEqual(
    runtime.startedSidecars.map(s => s.alias),
    ['everything', 'filesystem']
  );
  assert.deepEqual(runtime.removedContainers, [
    `${runName}-mcp-everything`,
    `${runName}-mcp-filesystem`,
  ]);
});
