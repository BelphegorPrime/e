import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { InMemoryGit } from '../../ports/git/memory.js';
import type {
  ContainerRunner,
  RunOptions,
  SidecarSpec,
} from '../../ports/runtime/index.js';
import { RunScratch } from '../runs/runScratch.js';
import { executeSpawn } from './executeSpawn.js';
import type { SpawnFacts, SpawnPlan } from './spawnPlan.js';
import type { Harness } from '../../core/harness/index.js';
import type { HarnessAgent } from '../../core/agent/index.js';
import { defaultBrokerPlan } from '../sidecarPlan.js';
import {
  ensureSpool,
  readStatus,
} from '../../sidecars/broker/contract/spool.js';

const harness: Harness = {
  name: 'demo',
  imageTag: 'e-harness-demo',
  dockerfile: { label: 'demo', npmPackage: 'demo' },
  requiredEnv: [],
  protocols: [],
  buildCommand: (prompt: string) => ['demo', '-p', prompt],
  buildInteractiveCommand: () => ['demo'],
};
const agent: HarnessAgent = { name: 'demo', harness: 'demo' };

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
    localStackPresent: false,
    rebuild: false,
    env: [],
    worktreesDir: '/tmp/e-worktrees',
    siblingArtifacts: ['node_modules'],
    maxSiblings: 3,
    localRuntimes: [],
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

// A {@link ContainerRunner} that records instead of driving an engine, so the
// whole executeSpawn path (preflight → build gate → env-file composition →
// runSpawn) is testable without a daemon. It implements the port rather than
// subclassing the real runtime pointed at a stand-in binary: every method
// executeSpawn reaches for - the image gate and the build included - is on the
// port.
class RecordingRuntime implements ContainerRunner {
  engine = 'docker';
  options?: RunOptions;
  /** The argv handed to the container (the harness command with its prompt). */
  ranCommand?: string[];
  /** Every container this run started, in order - a gated run starts two. */
  ranCommands: string[][] = [];
  built: string[] = [];
  sidecars: SidecarSpec[] = [];

  imageExists(_imageTag: string): boolean {
    return false;
  }

  build(tag: string, _dir: string): void {
    this.built.push(tag);
  }

  composeUp(): void {}

  async run(
    _image: string,
    opts: RunOptions,
    command: string[]
  ): Promise<number> {
    this.options = opts;
    this.ranCommand = command;
    this.ranCommands.push(command);
    return 0;
  }

  createNetwork(): void {}
  removeNetwork(): void {}

  startSidecar(spec: SidecarSpec): void {
    this.sidecars.push(spec);
  }

  removeContainer(): void {}

  probeTcp(): boolean {
    return true;
  }

  probeHealthcheck(): boolean {
    return true;
  }

  isRunning(): boolean {
    return true;
  }

  volumeExists(): boolean {
    return true;
  }
  createVolume(): void {}
  copyVolumeToDir(): void {}
  copyDirToVolume(): void {}
}

// The preflight guards (a git repo, foreground) run before any build, so a
// failing one must leave the runtime entirely untouched.
test('errors before any build when not in a git repository', async () => {
  const untouched = new RecordingRuntime();
  const scratch = new RunScratch();
  const result = await executeSpawn(facts(), emptyPlan, {
    git: new InMemoryGit({ repo: false }),
    runtime: untouched,
    scratch,
  });
  assert.equal(result.ran, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.error ?? '', /git repository/i);
  assert.deepEqual(untouched.built, []);
  assert.equal(untouched.ranCommand, undefined);
});

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
      { git: new InMemoryGit(), runtime, scratch }
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
    const kept = new InMemoryGit();
    await executeSpawn(facts({ root, keepWorktree: true }), emptyPlan, {
      git: kept,
      runtime: new RecordingRuntime(),
      scratch: new RunScratch(),
    });
    assert.deepEqual(kept.removedWorktrees, []);

    const removed = new InMemoryGit();
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
    const git = new InMemoryGit();
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
    assert.equal(git.worktrees.length, 1);
    assert.equal(
      git.worktrees[0].path,
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
      git: new InMemoryGit(),
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
      git: new InMemoryGit(),
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
      { git: new InMemoryGit(), runtime, scratch }
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

test('refuses a user --env-file that declares a never-forwarded variable', async () => {
  // The last channel into a container, and the only one copied verbatim (#153).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e-spawn-test-'));
  try {
    const user = path.join(tmp, 'user.env');
    fs.writeFileSync(user, 'USER_EXTRA=1\nOPENCODE_AUTO_SHARE=true\n');
    fs.mkdirSync(path.join(tmp, '.e', 'harnesses', 'demo'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmp, '.e', 'harnesses', 'demo', 'Dockerfile'),
      'FROM alpine\n'
    );

    const runtime = new RecordingRuntime();
    const scratch = new RunScratch();
    const result = await executeSpawn(
      facts({ root: tmp, userEnvFile: user }),
      emptyPlan,
      { git: new InMemoryGit(), runtime, scratch }
    );

    assert.equal(result.ran, false);
    assert.match(result.error ?? '', /OPENCODE_AUTO_SHARE/);
    assert.match(result.error ?? '', /never forwarded/);
    assert.equal(runtime.options, undefined);
    scratch.dispose();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a prompt runs one-shot: the harness gets the prompt, no TTY', async () => {
  await withDemoStore(async root => {
    const runtime = new RecordingRuntime();
    const result = await executeSpawn(
      facts({ root, prompt: 'print hello' }),
      emptyPlan,
      { git: new InMemoryGit(), runtime, scratch: new RunScratch() }
    );
    assert.equal(result.ran, true);
    assert.equal(runtime.options?.interactive, false);
    assert.deepEqual(runtime.ranCommand?.slice(0, 2), ['demo', '-p']);
    assert.match(runtime.ranCommand?.[2] ?? '', /print hello/);
  });
});

test('no prompt opens the harness TUI: interactive run, no one-shot command', async () => {
  await withDemoStore(async root => {
    const runtime = new RecordingRuntime();
    const result = await executeSpawn(facts({ root, prompt: '' }), emptyPlan, {
      git: new InMemoryGit(),
      runtime,
      scratch: new RunScratch(),
    });
    assert.equal(result.ran, true);
    assert.equal(runtime.options?.interactive, true);
    assert.deepEqual(runtime.ranCommand, ['demo']);
  });
});

test("the browser terminal's headless child (no prompt, E_TTY_HEADLESS) stays interactive", async () => {
  await withDemoStore(async root => {
    const runtime = new RecordingRuntime();
    await executeSpawn(
      facts({ root, prompt: '', headlessTty: true, name: 'from-browser' }),
      emptyPlan,
      { git: new InMemoryGit(), runtime, scratch: new RunScratch() }
    );
    assert.equal(runtime.options?.interactive, true);
    assert.equal(runtime.options?.headlessTty, true);
    assert.deepEqual(runtime.ranCommand, ['demo']);
  });
});

test('the role reaches the orchestrator: a child run is launched with the child prompt', async () => {
  await withDemoStore(async root => {
    const runtime = new RecordingRuntime();
    await executeSpawn(
      facts({ root, role: 'child' }),
      { ...emptyPlan, agentEnv: ['E_ROLE=child'] },
      { git: new InMemoryGit(), runtime, scratch: new RunScratch() }
    );
    // The plan's `-e` env is passed through untouched (the plan decided it) ...
    assert.deepEqual(runtime.options?.env, ['E_ROLE=child']);
    // ... and the launch prompt names the same role.
    assert.match(runtime.ranCommand?.[2] ?? '', /role in this run is "child"/);
  });
});

test('a planned broker seeds .e/broker on demand, builds e-broker, and starts the sidecar', async () => {
  await withDemoStore(async root => {
    const runtime = new RecordingRuntime();
    const worktreesDir = path.join(root, 'wt');
    const result = await executeSpawn(
      facts({ root, worktreesDir, name: 'sib-test' }),
      {
        ...emptyPlan,
        broker: defaultBrokerPlan(),
      },
      { git: new InMemoryGit(), runtime, scratch: new RunScratch() }
    );
    assert.equal(result.ran, true);
    // Build context written without e init having done so.
    const dockerfile = path.join(root, '.e', 'broker', 'Dockerfile');
    assert.ok(fs.existsSync(dockerfile));
    assert.ok(fs.existsSync(path.join(root, '.e', 'broker', 'broker.mjs')));
    assert.match(fs.readFileSync(dockerfile, 'utf8'), /FROM node:24-alpine/);
    assert.ok(runtime.built.includes('e-broker'));
    const broker = runtime.sidecars.find(s => s.alias === 'runtime-broker');
    assert.ok(broker);
    assert.equal(
      broker.volumes?.[0].host,
      path.join(worktreesDir, '.broker', 'e-demo-sib-test-1')
    );
  });
});

test('an edited .e/broker/Dockerfile is never clobbered by a spawn', async () => {
  await withDemoStore(async root => {
    const dir = path.join(root, '.e', 'broker');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
    await executeSpawn(
      facts({ root, worktreesDir: path.join(root, 'wt') }),
      {
        ...emptyPlan,
        broker: defaultBrokerPlan(),
      },
      {
        git: new InMemoryGit(),
        runtime: new RecordingRuntime(),
        scratch: new RunScratch(),
      }
    );
    assert.equal(
      fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8'),
      'FROM scratch\n'
    );
    assert.ok(fs.existsSync(path.join(dir, 'broker.mjs')));
  });
});

test('a sibling spawn joins the parent network, syncs the configured artifacts, and reports into the parent spool', async () => {
  await withDemoStore(async root => {
    const worktreesDir = path.join(root, 'wt');
    const parentWorktree = path.join(root, 'parent');
    fs.mkdirSync(path.join(parentWorktree, 'node_modules', 'pkg'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(parentWorktree, 'node_modules', 'pkg', 'index.js'),
      '1'
    );
    const spool = path.join(root, 'spool');
    ensureSpool(spool);

    const runtime = new RecordingRuntime();
    const result = await executeSpawn(
      facts({
        root,
        worktreesDir,
        name: 'sib-run',
        role: 'child',
        sibling: {
          parent: {
            worktreePath: parentWorktree,
            branch: 'e/demo/parent-1',
            network: 'e-demo-parent-1-net',
          },
          spoolDir: spool,
          id: 'sib-001',
        },
      }),
      emptyPlan,
      { git: new InMemoryGit(), runtime, scratch: new RunScratch() }
    );
    assert.equal(result.ran, true);
    assert.deepEqual(runtime.options?.networks, ['e-demo-parent-1-net']);
    assert.deepEqual(
      runtime.options?.volumes?.map(v => v.container),
      ['/workspace', '/workspace/node_modules']
    );
    const status = readStatus(spool, 'sib-001');
    assert.equal(status?.status, 'done');
    assert.equal(status?.branch, 'e/demo/sib-run-1');
  });
});

test("the store's verify declaration reaches the orchestrator: the check runs as a second container", async () => {
  await withDemoStore(async root => {
    const runtime = new RecordingRuntime();
    await executeSpawn(
      facts({ root, verify: { command: 'npm test' } }),
      emptyPlan,
      {
        git: new InMemoryGit({ dirty: true }),
        runtime,
        scratch: new RunScratch(),
      }
    );
    assert.deepEqual(runtime.ranCommands.at(-1), ['sh', '-c', 'npm test']);
    assert.equal(runtime.ranCommands.length, 2);
  });
});

test('a store with no verify declaration starts exactly one container', async () => {
  await withDemoStore(async root => {
    const runtime = new RecordingRuntime();
    await executeSpawn(facts({ root }), emptyPlan, {
      git: new InMemoryGit({ dirty: true }),
      runtime,
      scratch: new RunScratch(),
    });
    assert.equal(runtime.ranCommands.length, 1);
  });
});
