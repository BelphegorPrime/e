import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Git, RunCommit, RunRef, WorktreeSpec } from '../git/index.js';
import {
  ContainerRuntime,
  type RunOptions,
  type SidecarSpec,
} from '../runtime/index.js';
import { RunScratch } from '../runs/runScratch.js';
import { executeSpawn } from './executeSpawn.js';
import type { SpawnFacts, SpawnPlan } from './spawnPlan.js';
import type { Harness } from '../harness/index.js';
import type { Agent } from '../agent/index.js';

// The preflight guards (a git repo, foreground) run before any build, so they
// are reachable with a fake git and an untouched runtime.

class StubGit implements Git {
  removedWorktrees: string[] = [];
  addedWorktrees: WorktreeSpec[] = [];
  constructor(private repo: boolean) {}
  isRepo(): boolean {
    return this.repo;
  }
  headSha(): string {
    return 'basesha';
  }
  currentBranch(): string {
    return 'main';
  }
  listRunBranches(): string[] {
    return [];
  }
  listRunRefs(): RunRef[] {
    return [];
  }
  runLog(): RunCommit[] {
    return [];
  }
  branchExists(): boolean {
    return false;
  }
  addWorktree(spec: WorktreeSpec): void {
    this.addedWorktrees.push(spec);
  }
  isDirty(): boolean {
    return false;
  }
  commitAll(): void {}
  hasCommitsBeyondBase(): boolean {
    return false;
  }
  push(): void {}
  removeWorktree(worktreePath: string): void {
    this.removedWorktrees.push(worktreePath);
  }
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
  baseEnvWhitelist: [],
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

// A runtime that uses the harmless `true` binary for image probes but records
// the run options instead of starting a container, so the full executeSpawn
// path (preflight → build check → env-file composition → runSpawn) is testable.
class RecordingRuntime extends ContainerRuntime {
  options?: RunOptions;
  /** The argv handed to the container (the harness command with its prompt). */
  ranCommand?: string[];
  built: string[] = [];
  sidecars: SidecarSpec[] = [];

  constructor() {
    super('true');
  }

  imageExists(_imageTag: string): boolean {
    return false;
  }

  build(tag: string, _dir: string): void {
    this.built.push(tag);
  }

  async run(
    _image: string,
    opts: RunOptions,
    command: string[]
  ): Promise<number> {
    this.options = opts;
    this.ranCommand = command;
    return 0;
  }

  startSidecar(spec: SidecarSpec): void {
    this.sidecars.push(spec);
  }

  probeTcp(): boolean {
    return true;
  }
}

/** A repo with a demo harness Dockerfile, so executeSpawn passes preflight. */
async function withDemoStore<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e-spawn-exec-'));
  try {
    fs.mkdirSync(path.join(tmp, '.e', 'harnesses', 'demo'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmp, '.e', 'harnesses', 'demo', 'Dockerfile'),
      'FROM alpine\n'
    );
    return await fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('a sidecar with credentials gets its own env-file; one without gets none', async () => {
  await withDemoStore(async root => {
    const runtime = new RecordingRuntime();
    const scratch = new RunScratch();
    const result = await executeSpawn(
      facts({ root }),
      {
        ...emptyPlan,
        sidecars: [
          { alias: 'gh', image: 'mcp-gh', port: 3000 },
          { alias: 'plain', image: 'mcp-plain', port: 3001 },
        ],
        sidecarCredentials: { gh: 'GITHUB_TOKEN=abc\n' },
      },
      { git: new StubGit(true), runtime, scratch }
    );
    assert.equal(result.ran, true);
    const [gh, plain] = runtime.sidecars;
    assert.equal(gh.alias, 'gh');
    assert.equal(gh.envFile?.length, 1);
    assert.equal(fs.readFileSync(gh.envFile![0], 'utf8'), 'GITHUB_TOKEN=abc\n');
    assert.equal(plain.envFile, undefined);
    scratch.dispose();
  });
});

test('--keep-worktree reaches the orchestrator: a clean worktree is left in place', async () => {
  await withDemoStore(async root => {
    const kept = new StubGit(true);
    await executeSpawn(facts({ root, keepWorktree: true }), emptyPlan, {
      git: kept,
      runtime: new RecordingRuntime(),
      scratch: new RunScratch(),
    });
    assert.deepEqual(kept.removedWorktrees, []);

    const removed = new StubGit(true);
    await executeSpawn(facts({ root }), emptyPlan, {
      git: removed,
      runtime: new RecordingRuntime(),
      scratch: new RunScratch(),
    });
    assert.equal(removed.removedWorktrees.length, 1);
  });
});

test('worktreesDir reaches the orchestrator: the run worktree is cut under it', async () => {
  await withDemoStore(async root => {
    const git = new StubGit(true);
    const worktreesDir = path.join(os.tmpdir(), 'e-custom-worktrees');
    // `--name` pins the slug, so the expected path needs no slugify knowledge.
    await executeSpawn(
      facts({ root, worktreesDir, name: 'custom-run' }),
      emptyPlan,
      {
        git,
        runtime: new RecordingRuntime(),
        scratch: new RunScratch(),
      }
    );
    assert.equal(git.addedWorktrees.length, 1);
    assert.equal(
      git.addedWorktrees[0].path,
      path.join(worktreesDir, 'e', 'demo', 'custom-run-1')
    );
  });
});

test('does not attach the agent to a Compose network when the stack is present', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e-spawn-net-'));
  try {
    fs.mkdirSync(path.join(tmp, '.e', 'harnesses', 'demo'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmp, '.e', 'harnesses', 'demo', 'Dockerfile'),
      'FROM alpine\n'
    );
    fs.mkdirSync(path.join(tmp, '.e'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.e', 'compose.yaml'), 'services: {}\n');
    const withStack = new RecordingRuntime();
    const result = await executeSpawn(facts({ root: tmp }), emptyPlan, {
      git: new StubGit(true),
      runtime: withStack,
      scratch: new RunScratch(),
    });
    assert.equal(result.ran, true);
    assert.equal(withStack.options?.networks, undefined);
    assert.equal(withStack.options?.extraHosts, undefined);

    // No stack: unchanged default-bridge behavior.
    const plain = new RecordingRuntime();
    fs.rmSync(path.join(tmp, '.e', 'compose.yaml'));
    await executeSpawn(facts({ root: tmp }), emptyPlan, {
      git: new StubGit(true),
      runtime: plain,
      scratch: new RunScratch(),
    });
    assert.equal(plain.options?.networks, undefined);
    assert.equal(plain.options?.extraHosts, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('filters the base .e/.env to the plan whitelist before the container gets it (Zone 2)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e-spawn-test-'));
  try {
    const base = path.join(tmp, '.env');
    fs.writeFileSync(
      base,
      [
        '# base env',
        'ANTHROPIC_BASE_URL=http://localhost:20128',
        'MY_GATEWAY_KEY=sk-secret-123',
        'SECRET_TOKEN=hunter2',
        'UNRELATED=must-not-leak',
        '',
      ].join('\n')
    );
    const user = path.join(tmp, 'user.env');
    fs.writeFileSync(user, 'USER_EXTRA=1\n');
    fs.mkdirSync(path.join(tmp, '.e', 'harnesses', 'demo'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmp, '.e', 'harnesses', 'demo', 'Dockerfile'),
      'FROM alpine\n'
    );

    const runtime = new RecordingRuntime();
    const plan: SpawnPlan = {
      ...emptyPlan,
      baseEnvWhitelist: ['ANTHROPIC_BASE_URL', 'MY_GATEWAY_KEY'],
    };
    const scratch = new RunScratch();
    const result = await executeSpawn(
      facts({ root: tmp, baseEnvFile: base, userEnvFile: user }),
      plan,
      { git: new StubGit(true), runtime, scratch }
    );

    assert.equal(result.ran, true);
    // The base file is replaced by a filtered scratch copy, layered before the
    // user's --env-file exactly as the raw `.e/.env` used to be.
    const envFiles = runtime.options?.envFile ?? [];
    assert.equal(envFiles.length, 2);
    assert.notEqual(envFiles[0], base);
    assert.equal(envFiles[1], user);

    const delivered = fs.readFileSync(envFiles[0], 'utf8');
    // Whitelisted keys reach the container, values verbatim.
    assert.match(delivered, /^MY_GATEWAY_KEY=sk-secret-123$/m);
    assert.match(delivered, /^ANTHROPIC_BASE_URL=http:\/\/localhost:20128$/m);
    // Unknown keys never do.
    assert.doesNotMatch(delivered, /SECRET_TOKEN|UNRELATED/);
    scratch.dispose();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the role reaches the orchestrator: a child run is launched with the child prompt', async () => {
  await withDemoStore(async root => {
    const runtime = new RecordingRuntime();
    await executeSpawn(
      facts({ root, role: 'child', detached: true }),
      { ...emptyPlan, agentEnv: ['E_ROLE=child'] },
      { git: new StubGit(true), runtime, scratch: new RunScratch() }
    );
    // The plan's `-e` env is passed through untouched (the plan decided it) ...
    assert.deepEqual(runtime.options?.env, ['E_ROLE=child']);
    // ... and the launch prompt names the same role.
    assert.match(runtime.ranCommand?.[2] ?? '', /role in this run is "child"/);
  });
});
