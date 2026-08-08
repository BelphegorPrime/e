import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import type { Git, WorktreeSpec } from './git/index';
import type { ContainerRunner, RunOptions } from './runtime/index';
import type { Harness } from './harness/index';
import type { Agent } from './agent';
import { runSpawn, type RunSpawnDeps, type RunSpawnParams } from './runSpawn';
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
    } = {},
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

/** A `ContainerRunner` fake that records the run and returns a fixed exit code. */
class FakeRuntime implements ContainerRunner {
  ran = false;
  image?: string;
  options?: RunOptions;
  command?: string[];
  constructor(private exitCode = 0) {}
  async run(
    image: string,
    options: RunOptions,
    command: string[],
  ): Promise<number> {
    this.ran = true;
    this.image = image;
    this.options = options;
    this.command = command;
    return this.exitCode;
  }
}

const harness: Harness = {
  name: 'demo',
  imageTag: 'e-harness-demo',
  dockerfile: { label: 'demo', npmPackage: 'demo' },
  requiredEnv: [],
  buildCommand: (prompt: string) => ['demo', '-p', prompt],
};

/** The default agent for the demo harness (name mirrors the harness). */
const agent: Agent = { name: 'demo', harness: 'demo', tier: 'default' };

function makeDeps(overrides: Partial<RunSpawnDeps> = {}) {
  let ensureImageCalls = 0;
  const git = overrides.git ?? new FakeGit();
  const runtime = overrides.runtime ?? new FakeRuntime();
  const deps: RunSpawnDeps = {
    git,
    runtime,
    ensureImage: overrides.ensureImage ?? (() => { ensureImageCalls++; }),
  };
  return { deps, git: git as FakeGit, runtime: runtime as FakeRuntime, ensureImageCalls: () => ensureImageCalls };
}

function makeParams(overrides: Partial<RunSpawnParams> = {}): RunSpawnParams {
  return {
    agent,
    harness,
    prompt: 'Fix the flaky test',
    runOptions: { attach: true, rm: true },
    worktreesDir: '/tmp/e-worktrees',
    ...overrides,
  };
}

test('errors and does not touch the runtime when not in a git repo', async () => {
  const { deps, git, runtime, ensureImageCalls } = makeDeps({
    git: new FakeGit({ repo: false }),
  });
  const result = await runSpawn(deps, makeParams());

  assert.equal(result.ran, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.error ?? '', /git repository/i);
  assert.equal(runtime.ran, false);
  assert.equal(ensureImageCalls(), 0);
  assert.ok(!git.calls.includes('addWorktree'));
});

test('creates a worktree from HEAD on branch e/<harness>/<slug>-1 and runs the harness', async () => {
  const { deps, git, runtime, ensureImageCalls } = makeDeps();
  const result = await runSpawn(deps, makeParams());

  const slug = slugify('Fix the flaky test');
  assert.equal(git.worktrees.length, 1);
  assert.equal(git.worktrees[0].branch, `e/demo/${slug}-1`);
  assert.equal(git.worktrees[0].base, 'basesha');
  assert.equal(ensureImageCalls(), 1);

  assert.equal(runtime.ran, true);
  assert.equal(runtime.image, 'e-harness-demo');
  assert.equal(runtime.options?.workdir, '/workspace');
  assert.deepEqual(runtime.options?.volume, [
    `${git.worktrees[0].path}:/workspace`,
  ]);
  assert.deepEqual(runtime.command, ['demo', '-p', 'Fix the flaky test']);

  assert.equal(result.ran, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.branch, `e/demo/${slug}-1`);
});

test('the run branch uses the agent name, while the image stays the harness image', async () => {
  const { deps, git, runtime } = makeDeps();
  const smart: Agent = { name: 'smart-demo', harness: 'demo', tier: 'smart' };
  const result = await runSpawn(deps, makeParams({ agent: smart }));

  const slug = slugify('Fix the flaky test');
  assert.equal(result.branch, `e/smart-demo/${slug}-1`);
  assert.equal(git.listedPrefixes[0], `e/smart-demo/${slug}`);
  // The image is keyed on the harness, not the agent (no derived image yet).
  assert.equal(runtime.image, 'e-harness-demo');
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

test('refuses a detached run and does not touch the runtime', async () => {
  const { deps, git, runtime, ensureImageCalls } = makeDeps();
  const result = await runSpawn(
    deps,
    makeParams({ runOptions: { attach: false, rm: true } }),
  );

  assert.equal(result.ran, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.error ?? '', /--no-attach/);
  assert.equal(runtime.ran, false);
  assert.equal(ensureImageCalls(), 0);
  assert.ok(!git.calls.includes('addWorktree'));
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
  const { deps, git } = makeDeps({
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
  assert.equal(git.calls.filter((c) => c === 'addWorktree').length, 2);
});

test('rethrows a non-collision worktree failure immediately without retrying', async () => {
  const { deps, git } = makeDeps({
    git: new FakeGit({ addWorktreeError: 'fatal: permission denied' }),
  });
  await assert.rejects(runSpawn(deps, makeParams()), /permission denied/);
  // Exactly one attempt — no counter-bump storm on a genuine error.
  assert.equal(git.calls.filter((c) => c === 'addWorktree').length, 1);
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
