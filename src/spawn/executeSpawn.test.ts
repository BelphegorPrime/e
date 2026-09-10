import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Git, RunCommit, RunRef, WorktreeSpec } from '../git/index.js';
import { ContainerRuntime, type RunOptions } from '../runtime/index.js';
import { RunScratch } from '../runs/runScratch.js';
import { executeSpawn } from './executeSpawn.js';
import type { SpawnFacts, SpawnPlan } from './spawnPlan.js';
import type { Harness } from '../harness/index.js';
import type { Agent } from '../agent/index.js';

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
  built: string[] = [];

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
    _command: string[]
  ): Promise<number> {
    this.options = opts;
    return 0;
  }
}

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
