import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Git, WorktreeSpec } from './git/index';
import { ContainerRuntime } from './runtime/index';
import { RunScratch } from './runScratch';
import { executeSpawn } from './executeSpawn';
import type { SpawnFacts, SpawnPlan } from './spawnPlan';
import type { Harness } from './harness/index';
import type { Agent } from './agent';

// The preflight guards (a git repo, foreground) run before any build, so they
// are reachable with a fake git and an untouched runtime.

class StubGit implements Git {
  constructor(private repo: boolean) {}
  isRepo(): boolean {
    return this.repo;
  }
  headSha(): string {
    return 'basesha';
  }
  listRunBranches(): string[] {
    return [];
  }
  addWorktree(_spec: WorktreeSpec): void {}
  isDirty(): boolean {
    return false;
  }
  commitAll(): void {}
  hasCommitsBeyondBase(): boolean {
    return false;
  }
  push(): void {}
  removeWorktree(): void {}
}

const harness: Harness = {
  name: 'demo',
  imageTag: 'e-harness-demo',
  dockerfile: { label: 'demo', npmPackage: 'demo' },
  requiredEnv: [],
  protocols: [],
  buildCommand: (prompt: string) => ['demo', '-p', prompt],
};
const agent: Agent = { name: 'demo', harness: 'demo' };

function facts(overrides: Partial<SpawnFacts> = {}): SpawnFacts {
  return {
    root: '/root',
    agent,
    harness,
    storeEnv: {},
    mcpServers: [],
    perRunSkills: [],
    bakedSkills: [],
    prompt: 'do it',
    rebuild: false,
    env: [],
    attach: true,
    ...overrides,
  };
}

const emptyPlan: SpawnPlan = {
  sidecars: [],
  sidecarCredentials: {},
  remoteCredentials: [],
  mcpArgs: [],
  skillMounts: [],
  agentEnv: [],
};

// A runtime that must never be touched by a preflight failure.
const untouched = new ContainerRuntime('true');

test('errors before any build when not in a git repository', async () => {
  const scratch = new RunScratch();
  const result = await executeSpawn(facts(), emptyPlan, {
    git: new StubGit(false),
    runtime: untouched,
    scratch,
  });
  assert.equal(result.ran, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.error ?? '', /git repository/i);
});

test('refuses a detached run before any build', async () => {
  const scratch = new RunScratch();
  const result = await executeSpawn(facts({ attach: false }), emptyPlan, {
    git: new StubGit(true),
    runtime: untouched,
    scratch,
  });
  assert.equal(result.ran, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.error ?? '', /--no-attach/);
});
