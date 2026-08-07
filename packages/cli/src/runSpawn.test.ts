import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import type { Git, WorktreeSpec } from './git/index';
import type { ContainerRunner, RunOptions } from './runtime/index';
import type { Harness } from './harness/index';
import { runSpawn, type RunSpawnDeps, type RunSpawnParams } from './runSpawn';
import { slugify } from './slugify';

/** A `Git` fake that records what the orchestrator asked it to do. */
class FakeGit implements Git {
  repo: boolean;
  dirty: boolean;
  calls: string[] = [];
  worktrees: WorktreeSpec[] = [];
  removed: string[] = [];
  commits: { path: string; message: string }[] = [];

  constructor(opts: { repo?: boolean; dirty?: boolean } = {}) {
    this.repo = opts.repo ?? true;
    this.dirty = opts.dirty ?? false;
  }

  isRepo(): boolean {
    this.calls.push('isRepo');
    return this.repo;
  }
  addWorktree(spec: WorktreeSpec): void {
    this.calls.push('addWorktree');
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

test('creates a worktree from HEAD on branch e/<harness>/<slug> and runs the harness', async () => {
  const { deps, git, runtime, ensureImageCalls } = makeDeps();
  const result = await runSpawn(deps, makeParams());

  const slug = slugify('Fix the flaky test');
  assert.equal(git.worktrees.length, 1);
  assert.equal(git.worktrees[0].branch, `e/demo/${slug}`);
  assert.equal(git.worktrees[0].base, 'HEAD');
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
  assert.equal(result.branch, `e/demo/${slug}`);
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
  assert.equal(git.worktrees[0].branch, 'e/demo/my-custom-run');
  assert.equal(result.branch, 'e/demo/my-custom-run');
});
