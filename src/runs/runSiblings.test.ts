import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureSpool,
  readStatus,
  writeRequest,
  writeRunInfo,
  writeStatus,
} from '../broker/spool.js';
import { Env } from '../utils/env.js';
import type { Git, MergeOutcome } from '../git/index.js';
import { reportDirFor, writeRunReport } from './runArtifacts.js';
import {
  SiblingConsumer,
  assertCliEntry,
  logTail,
  siblingCliArgs,
  spawnSiblingProcess,
  type SiblingConsumerOptions,
  type SiblingLaunch,
  type SiblingProcess,
} from './runSiblings.js';

// The consumer is driven tick by tick here (no timers): the test plays the
// broker (spooling requests) and the sibling process (reporting status).

/** A launcher the test controls: records launches, lets the test end each process. */
class FakeLauncher {
  launches: SiblingLaunch[] = [];
  killed: string[] = [];
  private readonly exits = new Map<string, (code: number) => void>();
  throws?: string;

  launch = (launch: SiblingLaunch): SiblingProcess => {
    if (this.throws) throw new Error(this.throws);
    this.launches.push(launch);
    const id = launch.request.id;
    const exited = new Promise<number>(resolve => this.exits.set(id, resolve));
    return { exited, kill: () => this.killed.push(id) };
  };

  /** Ends the process for `id` with `code`; resolves once the consumer has reacted. */
  async exit(id: string, code: number): Promise<void> {
    this.exits.get(id)!(code);
    await new Promise(resolve => setImmediate(resolve));
  }
}

function withSpool<T>(
  role: 'parent' | 'child',
  fn: (spool: string) => Promise<T>
): Promise<T> {
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), 'e-siblings-'));
  ensureSpool(spool);
  writeRunInfo(spool, {
    name: 'e-demo-parent-1',
    branch: 'e/demo/parent-1',
    agent: 'demo',
    role,
    maxSiblings: 3,
  });
  return fn(spool).finally(() =>
    fs.rmSync(spool, { recursive: true, force: true })
  );
}

function request(spool: string, id: string, agent = 'researcher'): void {
  writeRequest(spool, { id, agent, prompt: `task ${id}`, requestedAt: 't' });
}

function consumer(
  spool: string,
  launcher: FakeLauncher,
  overrides: Partial<SiblingConsumerOptions> = {}
): SiblingConsumer {
  return new SiblingConsumer({
    spoolDir: spool,
    parent: {
      worktreePath: '/wt/e-demo-parent-1',
      branch: 'e/demo/parent-1',
      network: 'e-demo-parent-1-net',
      role: 'parent',
    },
    maxSiblings: 3,
    readiness: { attempts: 3, intervalMs: 1 },
    launch: launcher.launch,
    sleep: async () => {},
    now: () => new Date('2026-09-12T12:00:00.000Z'),
    ...overrides,
  });
}

test('siblingCliArgs: a detached spawn of the requested agent, passthrough before --, the prompt after', () => {
  const request = {
    id: 'sib-001',
    agent: 'researcher',
    prompt: '-x looks like a flag',
    requestedAt: 't',
  };
  assert.deepEqual(siblingCliArgs(request), [
    'spawn',
    'researcher',
    '--detached',
    '--',
    '-x looks like a flag',
  ]);
  assert.deepEqual(siblingCliArgs(request, ['--dir', '/store']), [
    'spawn',
    'researcher',
    '--detached',
    '--dir',
    '/store',
    '--',
    '-x looks like a flag',
  ]);
});

test('a new request is marked starting and launched with the sibling markers; the sibling reports the rest', async () => {
  await withSpool('parent', async spool => {
    const launcher = new FakeLauncher();
    const c = consumer(spool, launcher);
    request(spool, 'sib-001');

    c.tick();

    assert.equal(launcher.launches.length, 1);
    const [launch] = launcher.launches;
    assert.equal(launch.request.agent, 'researcher');
    assert.equal(launch.env[Env.SPAWN_ROLE_VAR], 'child');
    assert.equal(
      launch.env[Env.SPAWN_PARENT_WORKTREE_VAR],
      '/wt/e-demo-parent-1'
    );
    assert.equal(launch.env[Env.SPAWN_PARENT_BRANCH_VAR], 'e/demo/parent-1');
    assert.equal(
      launch.env[Env.SPAWN_PARENT_NETWORK_VAR],
      'e-demo-parent-1-net'
    );
    assert.equal(launch.env[Env.SPAWN_SPOOL_VAR], spool);
    assert.equal(launch.env[Env.SPAWN_SIBLING_ID_VAR], 'sib-001');
    assert.equal(launch.logFile, path.join(spool, 'logs', 'sib-001.log'));
    assert.deepEqual(readStatus(spool, 'sib-001'), {
      status: 'starting',
      updatedAt: '2026-09-12T12:00:00.000Z',
    });

    // A second tick does not launch it again.
    c.tick();
    assert.equal(launcher.launches.length, 1);

    // The sibling process reports for itself; the consumer leaves its result alone.
    writeStatus(spool, 'sib-001', {
      status: 'running',
      branch: 'e/researcher/task-1',
      updatedAt: 't',
    });
    writeStatus(spool, 'sib-001', {
      status: 'done',
      branch: 'e/researcher/task-1',
      exitCode: 0,
      updatedAt: 't',
    });
    await launcher.exit('sib-001', 0);
    assert.equal(readStatus(spool, 'sib-001')?.status, 'done');
  });
});

test('depth limit: a spool whose run is itself a sibling refuses every request', async () => {
  await withSpool('child', async spool => {
    const launcher = new FakeLauncher();
    const c = consumer(spool, launcher, {
      parent: {
        worktreePath: '/wt/sib',
        branch: 'e/demo/sib-1',
        role: 'child',
      },
    });
    request(spool, 'sib-001');
    c.tick();
    assert.equal(launcher.launches.length, 0);
    const status = readStatus(spool, 'sib-001');
    assert.equal(status?.status, 'failed');
    assert.match(status?.error ?? '', /Depth limit/);
  });
});

test('fan-out cap: further requests wait in arrival order until a slot frees', async () => {
  await withSpool('parent', async spool => {
    const launcher = new FakeLauncher();
    const c = consumer(spool, launcher, { maxSiblings: 1 });
    request(spool, 'sib-001');
    request(spool, 'sib-002');
    request(spool, 'sib-003');

    c.tick();
    assert.deepEqual(
      launcher.launches.map(l => l.request.id),
      ['sib-001']
    );
    assert.equal(readStatus(spool, 'sib-002'), undefined, 'still requested');
    assert.equal(readStatus(spool, 'sib-003'), undefined, 'still requested');

    // Running still occupies the slot.
    writeStatus(spool, 'sib-001', {
      status: 'running',
      branch: 'b',
      updatedAt: 't',
    });
    c.tick();
    assert.equal(launcher.launches.length, 1);

    // Done frees it: the next in line starts.
    writeStatus(spool, 'sib-001', {
      status: 'done',
      branch: 'b',
      exitCode: 0,
      updatedAt: 't',
    });
    await launcher.exit('sib-001', 0);
    c.tick();
    assert.deepEqual(
      launcher.launches.map(l => l.request.id),
      ['sib-001', 'sib-002']
    );
    assert.equal(readStatus(spool, 'sib-003'), undefined);
  });
});

test('readiness: a sibling that never reports running within the policy is killed and failed', async () => {
  await withSpool('parent', async spool => {
    const launcher = new FakeLauncher();
    const c = consumer(spool, launcher, {
      readiness: { attempts: 3, intervalMs: 1 },
    });
    request(spool, 'sib-001');
    c.tick(); // launched, starting
    c.tick(); // poll 1
    c.tick(); // poll 2
    assert.equal(readStatus(spool, 'sib-001')?.status, 'starting');
    assert.deepEqual(launcher.killed, []);
    c.tick(); // poll 3: given up
    assert.deepEqual(launcher.killed, ['sib-001']);
    const status = readStatus(spool, 'sib-001');
    assert.equal(status?.status, 'failed');
    assert.match(status?.error ?? '', /did not become ready in time/);
    // The killed process exiting later does not overwrite the verdict.
    await launcher.exit('sib-001', 1);
    assert.match(
      readStatus(spool, 'sib-001')?.error ?? '',
      /did not become ready/
    );
  });
});

test('a sibling that reports running in time is left alone by the readiness watch', async () => {
  await withSpool('parent', async spool => {
    const launcher = new FakeLauncher();
    const c = consumer(spool, launcher, {
      readiness: { attempts: 2, intervalMs: 1 },
    });
    request(spool, 'sib-001');
    c.tick();
    writeStatus(spool, 'sib-001', {
      status: 'running',
      branch: 'b',
      updatedAt: 't',
    });
    c.tick();
    c.tick();
    c.tick();
    assert.deepEqual(launcher.killed, []);
    assert.equal(readStatus(spool, 'sib-001')?.status, 'running');
  });
});

test('a sibling process that exits without reporting a result has failed, exit code attached', async () => {
  await withSpool('parent', async spool => {
    const launcher = new FakeLauncher();
    const c = consumer(spool, launcher);
    request(spool, 'sib-001');
    c.tick();
    // What the sibling printed before dying is the only clue: it rides along.
    const logFile = launcher.launches[0].logFile;
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(
      logFile,
      'building image\nUnknown agent or harness "researcher".\n'
    );
    await launcher.exit('sib-001', 2);
    const status = readStatus(spool, 'sib-001');
    assert.equal(status?.status, 'failed');
    assert.equal(status?.exitCode, 2);
    assert.match(
      status?.error ?? '',
      /exited with code 2 before reporting a result: building image \| Unknown agent or harness "researcher"\./
    );
  });
});

test('a launcher that cannot start the process fails the request with the reason', async () => {
  await withSpool('parent', async spool => {
    const launcher = new FakeLauncher();
    launcher.throws = 'spawn ENOENT';
    const c = consumer(spool, launcher);
    request(spool, 'sib-001');
    c.tick();
    const status = readStatus(spool, 'sib-001');
    assert.equal(status?.status, 'failed');
    assert.match(
      status?.error ?? '',
      /could not start the sibling process: spawn ENOENT/
    );
  });
});

test('start/stop: the loop polls until stopped; stop fails what is still waiting and awaits what is in flight', async () => {
  await withSpool('parent', async spool => {
    const launcher = new FakeLauncher();
    let sleeps = 0;
    const c = consumer(spool, launcher, {
      maxSiblings: 1,
      sleep: async () => {
        sleeps += 1;
        await new Promise(resolve => setImmediate(resolve));
      },
    });
    request(spool, 'sib-001');
    request(spool, 'sib-002');
    c.start();
    c.start(); // idempotent
    while (launcher.launches.length === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(sleeps >= 1);

    let stopped = false;
    const stopping = c.stop().then(() => {
      stopped = true;
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    // In flight: stop waits for it ...
    assert.equal(stopped, false);
    // ... and the one never picked up is failed, not left dangling.
    assert.match(
      readStatus(spool, 'sib-002')?.error ?? '',
      /parent run ended before the request was picked up/
    );
    writeStatus(spool, 'sib-001', {
      status: 'done',
      branch: 'b',
      exitCode: 0,
      updatedAt: 't',
    });
    await launcher.exit('sib-001', 0);
    await stopping;
    assert.equal(stopped, true);
    const sleepsAtStop = sleeps;
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(sleeps, sleepsAtStop, 'the loop is gone');
  });
});

test('the launched sibling inherits the passthrough arguments and environment', async () => {
  await withSpool('parent', async spool => {
    const launcher = new FakeLauncher();
    const c = consumer(spool, launcher, {
      passthroughArgs: ['--dir', '/store', '--env-file', 'user.env'],
      passthroughEnv: { [Env.RUNTIME_VAR]: 'podman' },
    });
    request(spool, 'sib-001');
    c.tick();
    const [launch] = launcher.launches;
    assert.deepEqual(launch.args, [
      'spawn',
      'researcher',
      '--detached',
      '--dir',
      '/store',
      '--env-file',
      'user.env',
      '--',
      'task sib-001',
    ]);
    assert.equal(launch.env[Env.RUNTIME_VAR], 'podman');
    assert.equal(launch.env[Env.SPAWN_ROLE_VAR], 'child');
  });
});

test('logTail: the last lines of a log, joined; empty for a missing or empty file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-logtail-'));
  try {
    const file = path.join(dir, 'sib.log');
    assert.equal(logTail(file), '');
    fs.writeFileSync(file, '');
    assert.equal(logTail(file), '');
    fs.writeFileSync(file, 'a\nb\nc\nd\n');
    assert.equal(logTail(file), 'b | c | d');
    assert.equal(logTail(file, 1), 'd');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertCliEntry: the CLI index.js or a single executable pass; any other entry is refused', () => {
  assert.deepEqual(
    assertCliEntry({ command: 'node', prefix: ['/x/dist/index.js'] }),
    {
      command: 'node',
      prefix: ['/x/dist/index.js'],
    }
  );
  assert.deepEqual(assertCliEntry({ command: '/x/e', prefix: [] }), {
    command: '/x/e',
    prefix: [],
  });
  // Under the test runner argv[1] is the test file: re-invoking it would be a fork bomb.
  assert.throws(
    () =>
      assertCliEntry({
        command: 'node',
        prefix: ['/x/dist/runs/runSpawn.test.js'],
      }),
    /Refusing to re-invoke "\/x\/dist\/runs\/runSpawn\.test\.js"/
  );
  assert.throws(
    () => assertCliEntry({ command: 'node', prefix: ['-e'] }),
    /Refusing/
  );
});

// The production launcher, driven with a scripted "CLI" (node -e) passed in
// explicitly instead of this very test file as the entry.
const scripted = (script: string) => ({
  command: process.execPath,
  prefix: ['-e', script],
});
const someRequest = {
  id: 'sib-001',
  agent: 'a',
  prompt: 'p',
  requestedAt: 't',
};

test('spawnSiblingProcess: runs the invocation with the args, logs its output, reports the exit code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-sibling-proc-'));
  try {
    const logFile = path.join(dir, 'logs', 'sib-001.log');
    const child = spawnSiblingProcess(
      { request: someRequest, args: ['spawn', 'a'], env: process.env, logFile },
      scripted(
        "console.log('building', process.argv.slice(1).join(' ')); console.error('boom'); process.exit(3)"
      )
    );
    assert.equal(await child.exited, 3);
    const logged = fs.readFileSync(logFile, 'utf8');
    assert.match(logged, /building spawn a/);
    assert.match(logged, /boom/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spawnSiblingProcess: kill ends a running sibling (exit code 1); a missing executable is exit code 1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-sibling-proc-'));
  try {
    const hanging = spawnSiblingProcess(
      {
        request: someRequest,
        args: [],
        env: process.env,
        logFile: path.join(dir, 'hang.log'),
      },
      scripted('setInterval(() => {}, 1000)')
    );
    hanging.kill();
    assert.equal(await hanging.exited, 1);
    const missing = spawnSiblingProcess(
      {
        request: someRequest,
        args: [],
        env: process.env,
        logFile: path.join(dir, 'missing.log'),
      },
      { command: path.join(dir, 'no-such-binary'), prefix: [] }
    );
    assert.equal(await missing.exited, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Merge-back (ticket 07): when a sibling reports done with its branch, the
// consumer folds the branch into the parent worktree with `Git.merge` and
// writes a report the parent agent reads from `e-runs/<runName>/report.md`.

/** A git fake recording merge attempts; outcome scriptable per branch. */
class RecordingGit implements Git {
  merges: { worktreePath: string; branch: string; message?: string }[] = [];
  private attempts = 0;
  constructor(
    private readonly outcomes: Record<string, MergeOutcome> = {},
    private readonly mergeThrows?: string,
    private readonly throwOnce = false
  ) {}
  isRepo(): boolean {
    return true;
  }
  headSha(): string {
    return 'sha';
  }
  currentBranch(): string {
    return 'main';
  }
  listRunBranches(): string[] {
    return [];
  }
  listRunRefs() {
    return [];
  }
  runLog() {
    return [];
  }
  branchExists(): boolean {
    return false;
  }
  addWorktree(): void {}
  isDirty(): boolean {
    return false;
  }
  commitAll(): void {}
  hasCommitsBeyondBase(): boolean {
    return false;
  }
  push(): void {}
  removeWorktree(): void {}
  merge(worktreePath: string, branch: string, message?: string): MergeOutcome {
    this.merges.push({ worktreePath, branch, message });
    this.attempts++;
    if (this.mergeThrows && (this.throwOnce ? this.attempts === 1 : true)) {
      throw new Error(this.mergeThrows);
    }
    return this.outcomes[branch] ?? { status: 'merged' };
  }
}

/** Drives a sibling to a terminal report and exit, as a real one would. */
async function finishSibling(
  spool: string,
  launcher: FakeLauncher,
  branch: string,
  status: 'done' | 'failed',
  exitCode = 0
): Promise<void> {
  writeStatus(spool, 'sib-001', {
    status,
    branch,
    ...(status === 'failed' ? { error: 'the sibling gave up' } : {}),
    exitCode,
    updatedAt: 't',
  });
  await launcher.exit('sib-001', exitCode);
}

function testWorktreesDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e-mergeback-'));
}

function consumerWithGit(
  spool: string,
  launcher: FakeLauncher,
  git: Git,
  worktreesDir: string
): SiblingConsumer {
  return consumer(spool, launcher, { git, worktreesDir });
}

test('a done sibling is merged into the parent worktree and reported', async () => {
  const worktreesDir = testWorktreesDir();
  try {
    await withSpool('parent', async spool => {
      const launcher = new FakeLauncher();
      const git = new RecordingGit();
      const c = consumerWithGit(spool, launcher, git, worktreesDir);
      request(spool, 'sib-001');
      c.tick();
      await finishSibling(spool, launcher, 'e/researcher/look-1', 'done');

      assert.deepEqual(git.merges, [
        {
          worktreePath: '/wt/e-demo-parent-1',
          branch: 'e/researcher/look-1',
          message: 'e: merge back e/researcher/look-1',
        },
      ]);
      const [result] = c.results;
      assert.equal(result.id, 'sib-001');
      assert.equal(result.branch, 'e/researcher/look-1');
      assert.equal(result.status, 'done');
      assert.equal(result.mergeStatus, 'merged');

      // The parent agent's report: branch-derived run name, telling it the
      // sibling's work is in its tree now.
      const report = path.join(
        worktreesDir,
        'e-runs',
        'e-researcher-look-1',
        'report.md'
      );
      assert.equal(fs.existsSync(report), true);
      const text = fs.readFileSync(report, 'utf8');
      assert.match(text, /Merged/);
      assert.match(text, /e\/researcher\/look-1/);
    });
  } finally {
    fs.rmSync(worktreesDir, { recursive: true, force: true });
  }
});

test('a merge conflict is held pending, files reported and written to the report; never auto-resolved', async () => {
  const worktreesDir = testWorktreesDir();
  try {
    await withSpool('parent', async spool => {
      const launcher = new FakeLauncher();
      const git = new RecordingGit({
        'e/researcher/look-1': {
          status: 'conflict',
          files: ['src/a.ts', 'src/b.ts'],
        },
      });
      const c = consumerWithGit(spool, launcher, git, worktreesDir);
      request(spool, 'sib-001');
      c.tick();
      await finishSibling(spool, launcher, 'e/researcher/look-1', 'done');

      const [result] = c.results;
      assert.equal(result.mergeStatus, 'conflict');
      assert.deepEqual(result.conflictFiles, ['src/a.ts', 'src/b.ts']);
      // The merge is left in progress with the markers; nothing was resolved.
      assert.equal(git.merges.length, 1);

      const text = fs.readFileSync(
        path.join(worktreesDir, 'e-runs', 'e-researcher-look-1', 'report.md'),
        'utf8'
      );
      assert.match(text, /Merge held pending/);
      assert.match(text, /src\/a\.ts/);
      assert.match(text, /src\/b\.ts/);
    });
  } finally {
    fs.rmSync(worktreesDir, { recursive: true, force: true });
  }
});

test('a merge git refuses (overlapping WIP in the parent) is held pending with the reason, not resolved', async () => {
  const worktreesDir = testWorktreesDir();
  try {
    await withSpool('parent', async spool => {
      const launcher = new FakeLauncher();
      // The parent's dirty worktree stands in the way of a clean merge, as
      // when the agent is mid-edit on files the sibling also touched.
      const git = new RecordingGit(
        {},
        'local changes would be overwritten by merge'
      );
      const c = consumerWithGit(spool, launcher, git, worktreesDir);
      request(spool, 'sib-001');
      c.tick();
      await finishSibling(spool, launcher, 'e/researcher/look-1', 'done');

      const [result] = c.results;
      assert.equal(result.mergeStatus, 'error');
      assert.match(result.logTail ?? '', /local changes would be overwritten/);
      // Refused: the worktree was untouched, nothing resolved, no conflict set.
      assert.equal(result.conflictFiles, undefined);
      const text = fs.readFileSync(
        path.join(worktreesDir, 'e-runs', 'e-researcher-look-1', 'report.md'),
        'utf8'
      );
      assert.match(text, /held pending/);
      assert.match(text, /local changes would be overwritten/);
    });
  } finally {
    fs.rmSync(worktreesDir, { recursive: true, force: true });
  }
});

test('a held merge is retried after the parent clears its WIP (the commit signal); conflicts never are', async () => {
  const worktreesDir = testWorktreesDir();
  try {
    await withSpool('parent', async spool => {
      const launcher = new FakeLauncher();
      // The sibling's branch conflicts on the first attempt, as when it
      // overlapped the parent's WIP; once the parent commits, it merges.
      const git = new RecordingGit(
        {},
        'local changes would be overwritten',
        true
      );
      const c = consumerWithGit(spool, launcher, git, worktreesDir);
      request(spool, 'sib-001');
      c.tick();
      await finishSibling(spool, launcher, 'e/researcher/look-1', 'done');

      // Held: the parent's WIP stood in the way.
      assert.equal(c.results[0].mergeStatus, 'error');

      // The parent finishes, commits its work (the clear signal), and the
      // host retries: the same sibling now lands as a clean merge commit.
      c.retryHeld();
      assert.equal(git.merges.length, 2);
      const [result] = c.results;
      assert.equal(result.mergeStatus, 'merged');
      assert.equal(result.id, 'sib-001');
      // Results are stable: a second retry has nothing left to do.
      c.retryHeld();
      assert.equal(c.results.length, 1);
    });
  } finally {
    fs.rmSync(worktreesDir, { recursive: true, force: true });
  }
});

test('a failed sibling is not merged; the report says so', async () => {
  const worktreesDir = testWorktreesDir();
  try {
    await withSpool('parent', async spool => {
      const launcher = new FakeLauncher();
      const git = new RecordingGit();
      const c = consumerWithGit(spool, launcher, git, worktreesDir);
      request(spool, 'sib-001');
      c.tick();
      await finishSibling(spool, launcher, 'ignored-branch', 'failed', 3);

      assert.deepEqual(git.merges, []);
      const [result] = c.results;
      assert.equal(result.status, 'failed');
      assert.equal(result.exitCode, 3);
      assert.equal(result.mergeStatus, 'not-done');
      assert.match(result.error ?? '', /gave up/);
      // Its report still lands, so the parent reads the failure in the same
      // place it reads merges - from the branch it announced before dying.
      const text = fs.readFileSync(
        path.join(worktreesDir, 'e-runs', 'ignored-branch', 'report.md'),
        'utf8'
      );
      assert.match(text, /the sibling gave up/);
      assert.match(text, /Merge failed/);
    });
  } finally {
    fs.rmSync(worktreesDir, { recursive: true, force: true });
  }
});

test('a sibling exiting before reporting done is failed, not merged', async () => {
  const worktreesDir = testWorktreesDir();
  try {
    await withSpool('parent', async spool => {
      const launcher = new FakeLauncher();
      const git = new RecordingGit();
      const c = consumerWithGit(spool, launcher, git, worktreesDir);
      request(spool, 'sib-001');
      c.tick();
      await launcher.exit('sib-001', 2);

      assert.equal(git.merges.length, 0);
      const [result] = c.results;
      assert.equal(result.status, 'failed');
      assert.equal(result.mergeStatus, 'not-done');
      assert.equal(readStatus(spool, 'sib-001')?.status, 'failed');
    });
  } finally {
    fs.rmSync(worktreesDir, { recursive: true, force: true });
  }
});
