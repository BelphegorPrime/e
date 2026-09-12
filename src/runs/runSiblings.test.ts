import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureSpool,
  hasMergeSignal,
  readStatus,
  signalMerge,
  writeRequest,
  writeRunInfo,
  writeStatus,
} from '../broker/spool.js';
import { Env } from '../utils/env.js';
import type { Git, MergeOutcome } from '../git/index.js';
import {
  SiblingConsumer,
  assertCliEntry,
  logTail,
  siblingCliArgs,
  siblingSummaryLine,
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
  // The parent's "worktree": where the consumer writes sibling reports.
  fs.mkdirSync(parentWorktree(spool));
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

/** The parent worktree that goes with a test spool. */
function parentWorktree(spool: string): string {
  return path.join(spool, 'parent-wt');
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
      worktreePath: parentWorktree(spool),
      branch: 'e/demo/parent-1',
      network: 'e-demo-parent-1-net',
      role: 'parent',
    },
    maxSiblings: 3,
    readiness: { attempts: 3, intervalMs: 1 },
    launch: launcher.launch,
    sleep: async () => {},
    now: () => new Date('2026-09-12T12:00:00.000Z'),
    git: new ScriptedGit(),
    ...overrides,
  });
}

/**
 * A `Git` for the merge-back seams: records checkpoints and merges in call
 * order, answers each branch's merge from a script (an outcome, a list of
 * outcomes consumed one per attempt, or an error to throw), and keeps a
 * conflict "in progress" until the next `commitAll` concludes it.
 */
class ScriptedGit implements Git {
  calls: string[] = [];
  merges: { branch: string; message?: string }[] = [];
  commits: string[] = [];
  dirty = false;
  merging = false;
  constructor(
    private readonly script: Record<
      string,
      MergeOutcome | Error | (MergeOutcome | Error)[]
    > = {}
  ) {}
  isRepo() {
    return true;
  }
  headSha() {
    return 'sha';
  }
  currentBranch() {
    return 'main';
  }
  listRunBranches() {
    return [];
  }
  listRunRefs() {
    return [];
  }
  runLog() {
    return [];
  }
  branchExists() {
    return true;
  }
  addWorktree() {}
  isDirty() {
    return this.dirty;
  }
  commitAll(_path: string, message: string) {
    this.calls.push(`commit ${message}`);
    this.commits.push(message);
    this.dirty = false;
    this.merging = false;
  }
  hasCommitsBeyondBase() {
    return true;
  }
  push() {}
  removeWorktree() {}
  merge(_path: string, branch: string, message?: string): MergeOutcome {
    this.calls.push(`merge ${branch}`);
    this.merges.push({ branch, message });
    const scripted = this.script[branch];
    let outcome: MergeOutcome | Error | undefined;
    if (Array.isArray(scripted)) {
      outcome = scripted.length > 1 ? scripted.shift() : scripted[0];
    } else {
      outcome = scripted;
    }
    if (outcome instanceof Error) throw outcome;
    const result = outcome ?? { status: 'merged' };
    if (result.status === 'conflict') this.merging = true;
    return result;
  }
  mergeInProgress() {
    return this.merging;
  }
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
      parentWorktree(spool)
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

// Merge-back (ticket 07): when a sibling exits, the consumer settles it -
// folds its branch into the parent worktree through `runMergeBack`, publishes
// the outcome into the sibling's status and as `e-runs/<id>/report.md` in the
// worktree - and retries a waiting merge on the parent's signal, when another
// merge lands, and when the parent run ends.

/** Drives a sibling to a terminal report and exit, as a real one would. */
async function finishSibling(
  spool: string,
  launcher: FakeLauncher,
  id: string,
  branch: string,
  status: 'done' | 'failed' = 'done',
  exitCode = 0
): Promise<void> {
  writeStatus(spool, id, {
    status,
    branch,
    ...(status === 'failed' ? { error: 'the sibling gave up' } : {}),
    exitCode,
    updatedAt: 't',
  });
  await launcher.exit(id, exitCode);
}

const reportOf = (spool: string, id: string) =>
  fs.readFileSync(
    path.join(parentWorktree(spool), 'e-runs', id, 'report.md'),
    'utf8'
  );

test('a done sibling is merged into the parent worktree; status and report carry the outcome', async () => {
  await withSpool('parent', async spool => {
    const launcher = new FakeLauncher();
    const git = new ScriptedGit();
    const c = consumer(spool, launcher, { git });
    request(spool, 'sib-001');
    c.tick();
    await finishSibling(spool, launcher, 'sib-001', 'e/researcher/look-1');

    assert.deepEqual(git.merges, [
      {
        branch: 'e/researcher/look-1',
        message: 'e: merge back e/researcher/look-1',
      },
    ]);
    assert.deepEqual(c.outcomes, [
      {
        id: 'sib-001',
        agent: 'researcher',
        branch: 'e/researcher/look-1',
        status: 'done',
        exitCode: 0,
        merge: { status: 'merged' },
        report: 'e-runs/sib-001/report.md',
      },
    ]);
    // The agent polls the status and finds the merge there ...
    const status = readStatus(spool, 'sib-001');
    assert.equal(status?.status, 'done');
    assert.deepEqual(status?.merge, { status: 'merged' });
    assert.equal(status?.report, 'e-runs/sib-001/report.md');
    // ... and the report in its own worktree, not on some host path.
    assert.match(reportOf(spool, 'sib-001'), /^# Sibling sib-001: merged/);
  });
});

test('a dirty parent is checkpointed before the merge, so its WIP is folded in and the merge is the last index write', async () => {
  await withSpool('parent', async spool => {
    const launcher = new FakeLauncher();
    const git = new ScriptedGit();
    git.dirty = true;
    const c = consumer(spool, launcher, { git });
    request(spool, 'sib-001');
    c.tick();
    await finishSibling(spool, launcher, 'sib-001', 'e/researcher/look-1');

    assert.deepEqual(git.calls, [
      'commit e: checkpoint e/demo/parent-1 before merging e/researcher/look-1',
      'merge e/researcher/look-1',
    ]);
    assert.equal(c.outcomes[0].merge.status, 'merged');
  });
});

test('a conflict is left in progress (never resolved by the host), holds the next sibling, and concludes on the parent signal; the held one then merges', async () => {
  await withSpool('parent', async spool => {
    const launcher = new FakeLauncher();
    const git = new ScriptedGit({
      'e/researcher/look-1': { status: 'conflict', files: ['src/a.ts'] },
    });
    const c = consumer(spool, launcher, { git });
    request(spool, 'sib-001');
    request(spool, 'sib-002');
    c.tick();
    await finishSibling(spool, launcher, 'sib-001', 'e/researcher/look-1');
    assert.deepEqual(readStatus(spool, 'sib-001')?.merge, {
      status: 'conflict',
      files: ['src/a.ts'],
    });
    const report = reportOf(spool, 'sib-001');
    assert.match(report, /conflict markers in:/);
    assert.match(report, /`src\/a\.ts`/);
    assert.match(report, /spawn-brother\.mjs --merge sib-001/);
    // Nothing was committed or resolved on the parent's behalf.
    assert.deepEqual(git.commits, []);

    // The second sibling finishes into a worktree mid-merge: held, no attempt.
    await finishSibling(spool, launcher, 'sib-002', 'e/researcher/look-2');
    assert.equal(readStatus(spool, 'sib-002')?.merge?.status, 'held');
    assert.match(
      readStatus(spool, 'sib-002')?.merge?.reason ?? '',
      /another merge-back is still in progress/
    );
    assert.deepEqual(
      git.merges.map(m => m.branch),
      ['e/researcher/look-1']
    );

    // The parent resolves the markers and signals through the broker; the
    // next tick concludes the merge as a commit, then the held one lands too.
    signalMerge(spool, 'sib-001', 't');
    c.tick();
    assert.equal(hasMergeSignal(spool, 'sib-001'), false);
    assert.deepEqual(git.commits, [
      'e: merge back e/researcher/look-1 (conflict resolved in e/demo/parent-1)',
    ]);
    assert.deepEqual(readStatus(spool, 'sib-001')?.merge, { status: 'merged' });
    assert.deepEqual(readStatus(spool, 'sib-002')?.merge, { status: 'merged' });
    assert.deepEqual(
      git.merges.map(m => m.branch),
      ['e/researcher/look-1', 'e/researcher/look-2']
    );
    assert.match(reportOf(spool, 'sib-001'), /^# Sibling sib-001: merged/);
    assert.match(reportOf(spool, 'sib-002'), /^# Sibling sib-002: merged/);
    // A signal for a sibling with nothing to retry is simply taken and ignored.
    assert.deepEqual(
      c.outcomes.map(o => o.merge.status),
      ['merged', 'merged']
    );
  });
});

test('a merge refused over files in flight is held with the files named; the parent signals, the host retries', async () => {
  await withSpool('parent', async spool => {
    const launcher = new FakeLauncher();
    const git = new ScriptedGit({
      'e/researcher/look-1': [
        { status: 'refused', files: ['src/a.ts', 'src/b.ts'] },
        { status: 'merged' },
      ],
    });
    const c = consumer(spool, launcher, { git });
    request(spool, 'sib-001');
    c.tick();
    await finishSibling(spool, launcher, 'sib-001', 'e/researcher/look-1');

    const held = readStatus(spool, 'sib-001')?.merge;
    assert.equal(held?.status, 'held');
    assert.deepEqual(held?.files, ['src/a.ts', 'src/b.ts']);
    assert.match(held?.reason ?? '', /in flight/);
    const report = reportOf(spool, 'sib-001');
    assert.match(report, /Files in the way:/);
    assert.match(report, /`src\/b\.ts`/);
    assert.match(report, /--merge sib-001/);

    // No signal, no retry: ticks leave it alone.
    c.tick();
    assert.equal(git.merges.length, 1);

    signalMerge(spool, 'sib-001', 't');
    c.tick();
    assert.equal(git.merges.length, 2);
    assert.deepEqual(readStatus(spool, 'sib-001')?.merge, { status: 'merged' });
    assert.equal(c.outcomes[0].merge.status, 'merged');
  });
});

test('finish (the parent run ended, its work committed): held merges get their last retry; a conflict the run commit concluded is merged', async () => {
  await withSpool('parent', async spool => {
    const launcher = new FakeLauncher();
    const git = new ScriptedGit({
      'e/researcher/look-1': { status: 'conflict', files: ['x'] },
      'e/researcher/look-2': [
        { status: 'refused', files: ['y'] },
        { status: 'merged' },
      ],
    });
    const c = consumer(spool, launcher, { git });
    request(spool, 'sib-001');
    request(spool, 'sib-002');
    c.tick();
    await finishSibling(spool, launcher, 'sib-001', 'e/researcher/look-1');
    // A refusal while a conflict is in progress reads as "in progress" first;
    // script the conflict concluded by the run's own commit before sib-002.
    git.commitAll(parentWorktree(spool), 'e: run output for e/demo/parent-1');
    await finishSibling(spool, launcher, 'sib-002', 'e/researcher/look-2');
    assert.equal(readStatus(spool, 'sib-001')?.merge?.status, 'conflict');
    assert.equal(readStatus(spool, 'sib-002')?.merge?.status, 'held');

    c.finish();
    // The conflict was concluded by the run's own commit, not by the parent's
    // hand: merged, but said so, since the files may still carry markers.
    const concluded = readStatus(spool, 'sib-001')?.merge;
    assert.equal(concluded?.status, 'merged');
    assert.match(concluded?.reason ?? '', /leftover conflict markers/);
    assert.match(reportOf(spool, 'sib-001'), /^# Sibling sib-001: merged/);
    assert.deepEqual(readStatus(spool, 'sib-002')?.merge, { status: 'merged' });
    assert.deepEqual(
      c.outcomes.map(o => [o.id, o.merge.status]),
      [
        ['sib-001', 'merged'],
        ['sib-002', 'merged'],
      ]
    );
  });
});

test('finish leaves a conflict still in progress alone: only the parent could have resolved it', async () => {
  await withSpool('parent', async spool => {
    const launcher = new FakeLauncher();
    const git = new ScriptedGit({
      'e/researcher/look-1': { status: 'conflict', files: ['x'] },
    });
    const c = consumer(spool, launcher, { git });
    request(spool, 'sib-001');
    c.tick();
    await finishSibling(spool, launcher, 'sib-001', 'e/researcher/look-1');
    c.finish();
    assert.equal(readStatus(spool, 'sib-001')?.merge?.status, 'conflict');
    assert.deepEqual(git.commits, []);
  });
});

test('a failed sibling, a non-zero exit, and a process that dies unreported are skipped, not merged, with reports', async () => {
  await withSpool('parent', async spool => {
    const launcher = new FakeLauncher();
    const git = new ScriptedGit();
    const c = consumer(spool, launcher, { git });
    request(spool, 'sib-001');
    request(spool, 'sib-002');
    request(spool, 'sib-003');
    c.tick();
    await finishSibling(spool, launcher, 'sib-001', 'e/r/one-1', 'failed', 3);
    await finishSibling(spool, launcher, 'sib-002', 'e/r/two-1', 'done', 2);
    await launcher.exit('sib-003', 1);

    assert.deepEqual(git.merges, []);
    const [one, two, three] = c.outcomes;
    assert.equal(one.status, 'failed');
    assert.equal(one.exitCode, 3);
    assert.equal(one.merge.status, 'skipped');
    assert.match(
      one.merge.reason ?? '',
      /the sibling failed: the sibling gave up/
    );
    assert.match(reportOf(spool, 'sib-001'), /Not merged: the sibling failed/);
    assert.match(reportOf(spool, 'sib-001'), /branch `e\/r\/one-1` keeps/);

    assert.equal(two.status, 'done');
    assert.equal(two.merge.status, 'skipped');
    assert.match(two.merge.reason ?? '', /exited with code 2/);

    assert.equal(three.status, 'failed');
    assert.equal(three.merge.status, 'skipped');
    assert.match(
      readStatus(spool, 'sib-003')?.error ?? '',
      /exited with code 1 before reporting/
    );
    assert.match(reportOf(spool, 'sib-003'), /^# Sibling sib-003: skipped/);
    // The status keeps the failure and gains the merge disposition.
    assert.equal(readStatus(spool, 'sib-003')?.status, 'failed');
    assert.equal(readStatus(spool, 'sib-003')?.merge?.status, 'skipped');
  });
});

test('a request the parent run ended on is failed and reported, so the agent finds every sibling in e-runs', async () => {
  await withSpool('parent', async spool => {
    const launcher = new FakeLauncher();
    const c = consumer(spool, launcher);
    request(spool, 'sib-001');
    await c.stop();
    assert.equal(readStatus(spool, 'sib-001')?.merge?.status, 'skipped');
    assert.match(
      reportOf(spool, 'sib-001'),
      /the parent run ended before the request was picked up/
    );
  });
});

test('a signal for a sibling with nothing to retry is consumed, not left in the spool', async () => {
  await withSpool('parent', async spool => {
    const launcher = new FakeLauncher();
    const git = new ScriptedGit();
    const c = consumer(spool, launcher, { git });
    request(spool, 'sib-001');
    c.tick();
    await finishSibling(spool, launcher, 'sib-001', 'e/researcher/look-1');
    assert.equal(readStatus(spool, 'sib-001')?.merge?.status, 'merged');

    signalMerge(spool, 'sib-001', 't');
    c.tick();
    assert.equal(hasMergeSignal(spool, 'sib-001'), false);
    assert.equal(git.merges.length, 1);
  });
});

test('a git lock collision (the sibling process checkpointing the same worktree) holds the merge instead of failing it, and a later landing retries it', async () => {
  await withSpool('parent', async spool => {
    const launcher = new FakeLauncher();
    const git = new ScriptedGit({
      'e/researcher/look-1': [
        new Error(
          "git failed (merge): fatal: Unable to create '/wt/.git/index.lock': File exists.\nAnother git process seems to be running in this repository"
        ),
        { status: 'merged' },
      ],
    });
    const c = consumer(spool, launcher, { git });
    request(spool, 'sib-001');
    request(spool, 'sib-002');
    c.tick();
    await finishSibling(spool, launcher, 'sib-001', 'e/researcher/look-1');
    const held = readStatus(spool, 'sib-001')?.merge;
    assert.equal(held?.status, 'held');
    assert.match(
      held?.reason ?? '',
      /another git process was using your worktree/
    );

    await finishSibling(spool, launcher, 'sib-002', 'e/researcher/look-2');
    assert.deepEqual(
      c.outcomes.map(o => [o.id, o.merge.status]),
      [
        ['sib-001', 'merged'],
        ['sib-002', 'merged'],
      ]
    );
  });
});

test('siblingSummaryLine: who, how it ended, how its work came back', () => {
  assert.equal(
    siblingSummaryLine({
      id: 'sib-001',
      agent: 'researcher',
      branch: 'e/researcher/look-1',
      status: 'done',
      exitCode: 0,
      merge: { status: 'merged' },
      report: 'e-runs/sib-001/report.md',
    }),
    'Sibling sib-001 (researcher, e/researcher/look-1): done, merge-back merged'
  );
  assert.equal(
    siblingSummaryLine({
      id: 'sib-002',
      agent: 'researcher',
      status: 'failed',
      merge: { status: 'skipped', reason: 'the sibling failed: gave up' },
    }),
    'Sibling sib-002 (researcher): failed, merge-back skipped - the sibling failed: gave up'
  );
  assert.equal(
    siblingSummaryLine({
      id: 'sib-003',
      agent: 'researcher',
      branch: 'e/researcher/x-1',
      status: 'done',
      merge: { status: 'conflict', files: ['a.ts', 'b.ts'] },
    }),
    'Sibling sib-003 (researcher, e/researcher/x-1): done, merge-back conflict [a.ts, b.ts]'
  );
});
