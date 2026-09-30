import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Env } from '../../shared/utils/env.js';
import {
  DEFAULT_DEAD_CONFIG,
  DEFAULT_QUEUE_CONFIG,
} from '../../core/store/config.js';
import type { ChildLaunch, ChildLauncher } from '../runs/childRun.js';
import { baseError } from '../../core/trigger/oneShot.js';
import { RunQueue, type NewRunRequest } from './runQueue.js';
import {
  ledgerFile,
  listDead,
  listLedger,
  listQueue,
  newRequestId,
  patchLedgerFile,
  readDeadRequest,
  readLedgerEntry,
  runsDirs,
  writeLedgerEntry,
  type RunsDirs,
} from './runsSpool.js';

/** A launcher whose children exit when the test says so. */
class ScriptedLauncher {
  readonly launches: ChildLaunch[] = [];
  private readonly exits = new Map<string, (code: number) => void>();

  readonly launch: ChildLauncher = launch => {
    this.launches.push(launch);
    const exited = new Promise<number>(resolve =>
      this.exits.set(launch.request.id, resolve)
    );
    return { exited, kill: () => {} };
  };

  async exit(id: string, code = 0): Promise<void> {
    this.exits.get(id)?.(code);
    // Let the queue's exit handler run.
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function withQueue<T>(
  fn: (ctx: {
    dirs: RunsDirs;
    launcher: ScriptedLauncher;
    running: Set<string>;
    queue: RunQueue;
  }) => Promise<T> | T,
  config = DEFAULT_QUEUE_CONFIG,
  dead = DEFAULT_DEAD_CONFIG
): Promise<T> {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'e-queue-'));
  try {
    const dirs = runsDirs(store);
    const launcher = new ScriptedLauncher();
    const running = new Set<string>();
    const queue = new RunQueue({
      dirs,
      config,
      dead,
      containerRunning: name => running.has(name),
      launch: launcher.launch,
    });
    return await fn({ dirs, launcher, running, queue });
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
}

const req = (key: string): NewRunRequest => ({
  key,
  trigger: key.split(':')[0],
  agent: 'pi',
  prompt: `work on ${key}`,
  event: { source: 'cron', event: 'tick', id: '20260918T0300Z' },
});

test('enqueue fills a free slot at once; beyond the slots requests wait, and a slot freed starts the next', () =>
  withQueue(async ({ dirs, launcher, queue }) => {
    for (const key of ['t:1', 't:2', 't:3']) {
      assert.equal(queue.enqueue(req(key)).status, 'enqueued');
    }
    // Default two slots: two runs, one request still waiting.
    assert.equal(launcher.launches.length, 2);
    assert.deepEqual(
      listQueue(dirs).map(r => r.key),
      ['t:3']
    );
    assert.equal(queue.heldSlots(), 2);

    // The child reports into the entry serve claimed, via E_LEDGER_FILE.
    const first = launcher.launches[0];
    assert.equal(
      first.env[Env.LEDGER_FILE_VAR],
      path.join(dirs.live, `${first.request.id}.json`)
    );
    assert.deepEqual(first.args.slice(0, 2), ['spawn', 'pi']);
    patchLedgerFile(first.env[Env.LEDGER_FILE_VAR]!, {
      state: 'done',
      exitCode: 0,
      endedAt: new Date().toISOString(),
    });
    await launcher.exit(first.request.id, 0);

    assert.equal(launcher.launches.length, 3);
    assert.deepEqual(listQueue(dirs), []);
  }));

test('a manual spawn is in the ledger and takes no slot', () =>
  withQueue(({ dirs, launcher, queue }) => {
    writeLedgerEntry(dirs, {
      id: newRequestId('man'),
      state: 'running',
      slot: false,
      agent: 'codex',
      run: 'e/codex/by-hand-1',
      container: 'e-codex-by-hand-1',
    });
    queue.enqueue(req('t:1'));
    queue.enqueue(req('t:2'));
    assert.equal(launcher.launches.length, 2);
    assert.equal(listLedger(dirs).length, 3);
  }));

test('liveTriggers: triggers owning an unended ledger entry, never a pending request or a finished run', () =>
  withQueue(
    async ({ launcher, queue }) => {
      queue.enqueue(req('running:1'));
      queue.enqueue(req('done:1'));
      queue.enqueue(req('waiting:1'));
      assert.deepEqual([...queue.liveTriggers()].sort(), ['done', 'running']);
      const done = launcher.launches.find(l =>
        l.request.prompt.includes('done')
      );
      patchLedgerFile(done!.env[Env.LEDGER_FILE_VAR]!, { state: 'done' });
      assert.deepEqual([...queue.liveTriggers()], ['running']);
    },
    { ...DEFAULT_QUEUE_CONFIG, slots: 2 }
  ));

test('a child that exits before its run branch existed is a dead request, and its slot freed', () =>
  withQueue(async ({ dirs, launcher, queue }) => {
    queue.enqueue(req('t:1'));
    const id = launcher.launches[0].request.id;
    await launcher.exit(id, 1);
    assert.equal(readLedgerEntry(dirs, id), undefined);
    const dead = readDeadRequest(dirs, id);
    assert.equal(dead?.stage, 'launch');
    assert.match(
      dead?.reason ?? '',
      /exited with code 1 before ending its run/
    );
    assert.equal(queue.heldSlots(), 0);
  }));

test('a run that failed, was exhausted, aborted or verify-red with a branch stays in the ledger, never dead', () =>
  withQueue(async ({ dirs, launcher, queue }) => {
    const outcomes = ['failed', 'exhausted', 'aborted', 'verify-red'];
    for (const outcome of outcomes) queue.enqueue(req(`t:${outcome}`));
    // Two slots: finish them in pairs.
    while (
      launcher.launches.length < outcomes.length ||
      listLedger(dirs).some(e => e.state === 'claimed')
    ) {
      const running = listLedger(dirs).filter(e => e.state === 'claimed');
      for (const entry of running) {
        const outcome = entry.request!.key.slice(2);
        patchLedgerFile(ledgerFile(dirs, entry.id), {
          state: outcome === 'failed' ? 'failed' : 'done',
          run: `e/pi/${outcome}-1`,
          ...(outcome === 'failed' ? {} : { outcome }),
        });
        await launcher.exit(entry.id, 1);
      }
    }
    assert.deepEqual(listDead(dirs), []);
    assert.equal(listLedger(dirs).length, 4);
  }));

test('an interrupted claim (serve restarted without its container) is never a dead request', () =>
  withQueue(({ dirs, queue }) => {
    writeLedgerEntry(dirs, {
      id: newRequestId('trg'),
      state: 'claimed',
      slot: true,
      agent: 'pi',
      run: null,
      request: {
        ...req('t:gone'),
        id: newRequestId('trg'),
        enqueuedAt: '2026-09-18T03:00:00Z',
      },
    });
    queue.reconcile();
    assert.deepEqual(listDead(dirs), []);
    assert.equal(listLedger(dirs)[0].state, 'interrupted');
  }));

test('a base that does not resolve at claim is a dead request, and no child is started', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'e-queue-'));
  try {
    const dirs = runsDirs(store);
    const launcher = new ScriptedLauncher();
    const asked: (string | undefined)[] = [];
    const queue = new RunQueue({
      dirs,
      config: DEFAULT_QUEUE_CONFIG,
      containerRunning: () => false,
      launch: launcher.launch,
      resolveBase: name => {
        asked.push(name);
        if (name === 'refs/pull/7/head') {
          throw baseError('base "refs/pull/7/head" is a pull request ref');
        }
        if (name === 'git-broke') {
          throw new Error('fatal: not a git repository');
        }
        return {
          ref: 'refs/remotes/origin/main',
          sha: 'abc1234',
          branch: 'main',
        };
      },
    });
    const bad = queue.enqueue({ ...req('t:pr'), base: 'refs/pull/7/head' });
    const broke = queue.enqueue({ ...req('t:git'), base: 'git-broke' });
    const good = queue.enqueue(req('t:ok'));
    assert.deepEqual(asked, ['refs/pull/7/head', 'git-broke', undefined]);
    assert.equal(launcher.launches.length, 1);
    // Only a base error is a base death; a git that failed is a launch failure.
    const brokeId = broke.status === 'enqueued' ? broke.request.id : '';
    assert.equal(readDeadRequest(dirs, brokeId)?.stage, 'launch');
    const badId = bad.status === 'enqueued' ? bad.request.id : '';
    const dead = readDeadRequest(dirs, badId);
    assert.equal(dead?.stage, 'base');
    assert.match(dead?.reason ?? '', /pull request ref/);
    // The run that launched carries its resolved base for its e spawn.
    const goodId = good.status === 'enqueued' ? good.request.id : '';
    assert.deepEqual(readLedgerEntry(dirs, goodId)?.base, {
      ref: 'refs/remotes/origin/main',
      sha: 'abc1234',
      branch: 'main',
    });
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('a launch that throws is a dead request', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'e-queue-'));
  try {
    const dirs = runsDirs(store);
    const queue = new RunQueue({
      dirs,
      config: DEFAULT_QUEUE_CONFIG,
      containerRunning: () => false,
      launch: () => {
        throw new Error('spawn ENOENT');
      },
    });
    const result = queue.enqueue(req('t:1'));
    const id = result.status === 'enqueued' ? result.request.id : '';
    assert.match(readDeadRequest(dirs, id)?.reason ?? '', /spawn ENOENT/);
    assert.equal(queue.heldSlots(), 0);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('an overflow rejection is a dead request by write, and the count cap drops the oldest at once', () =>
  withQueue(
    ({ dirs, queue }) => {
      assert.equal(queue.enqueue(req('t:1')).status, 'enqueued');
      assert.equal(queue.enqueue(req('t:2')).status, 'full');
      assert.equal(queue.enqueue(req('t:3')).status, 'full');
      assert.equal(queue.enqueue(req('t:4')).status, 'full');
      assert.deepEqual(
        listDead(dirs).map(d => [d.request.key, d.stage]),
        [
          ['t:3', 'overflow'],
          ['t:4', 'overflow'],
        ]
      );
    },
    { ...DEFAULT_QUEUE_CONFIG, slots: 0, maxLength: 1 },
    { maxAgeMs: DEFAULT_DEAD_CONFIG.maxAgeMs, maxCount: 2 }
  ));

test('duplicate and full are rejected and logged, never dropping what was accepted', () =>
  withQueue(
    ({ dirs, launcher, queue }) => {
      // One slot: t:1 starts, the rest wait.
      assert.equal(queue.enqueue(req('t:1')).status, 'enqueued');
      assert.equal(queue.enqueue(req('t:2')).status, 'enqueued');
      assert.equal(queue.enqueue(req('t:2')).status, 'duplicate');
      assert.equal(queue.enqueue(req('t:3')).status, 'enqueued');
      assert.equal(queue.enqueue(req('t:4')).status, 'full');
      assert.equal(launcher.launches.length, 1);
      assert.deepEqual(
        listQueue(dirs).map(r => r.key),
        ['t:2', 't:3']
      );
    },
    { ...DEFAULT_QUEUE_CONFIG, slots: 1, maxLength: 2 }
  ).then(() => undefined));

test('restart: a run whose container is gone is interrupted and frees its slot; one still running keeps it', () =>
  withQueue(({ dirs, launcher, running, queue }) => {
    const alive = writeLedgerEntry(dirs, {
      id: newRequestId('trg'),
      state: 'running',
      slot: true,
      agent: 'pi',
      run: 'e/pi/alive-1',
      container: 'e-pi-alive-1',
    });
    const gone = writeLedgerEntry(dirs, {
      id: newRequestId('trg'),
      state: 'running',
      slot: true,
      agent: 'pi',
      run: 'e/pi/gone-1',
      container: 'e-pi-gone-1',
    });
    // Claimed, never started: no container at all.
    const claimed = writeLedgerEntry(dirs, {
      id: newRequestId('trg'),
      state: 'claimed',
      slot: true,
      agent: 'pi',
      run: null,
    });
    running.add('e-pi-alive-1');
    assert.equal(queue.heldSlots(), 3);

    queue.reconcile();

    const byFile = (file: string) =>
      listLedger(dirs).find(e => file.endsWith(`${e.id}.json`));
    assert.equal(byFile(alive)?.state, 'running');
    assert.equal(byFile(gone)?.state, 'interrupted');
    assert.equal(byFile(claimed)?.state, 'interrupted');
    // The branch stays named; nothing is retried.
    assert.equal(byFile(gone)?.run, 'e/pi/gone-1');
    assert.equal(queue.heldSlots(), 1);

    queue.enqueue(req('t:1'));
    queue.enqueue(req('t:2'));
    // Two slots, one held by the survivor.
    assert.equal(launcher.launches.length, 1);
  }));

test('tick: expired requests are dropped, finished runs past retention swept', () => {
  let now = new Date('2026-09-29T10:00:00.000Z');
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'e-queue-'));
  try {
    const dirs = runsDirs(store);
    const launcher = new ScriptedLauncher();
    const queue = new RunQueue({
      dirs,
      config: {
        ...DEFAULT_QUEUE_CONFIG,
        slots: 1,
        ttlMs: 60_000,
        retentionMs: 60_000,
      },
      containerRunning: () => false,
      launch: launcher.launch,
      now: () => now,
    });
    const done = writeLedgerEntry(dirs, {
      id: newRequestId('man'),
      state: 'done',
      slot: false,
      agent: 'pi',
      run: 'e/pi/old-1',
      endedAt: now.toISOString(),
    });
    queue.enqueue(req('t:running'));
    queue.enqueue(req('t:waiting'));
    assert.equal(launcher.launches.length, 1);

    now = new Date('2026-09-29T10:05:00.000Z');
    queue.tick();

    assert.deepEqual(listQueue(dirs), []);
    assert.equal(fs.existsSync(done), false);
    // The running one is bounded by its caps, never by the queue TTL.
    assert.equal(listLedger(dirs).length, 1);
    assert.equal(listLedger(dirs)[0].state, 'claimed');
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('provenance: an event id that would forge a trailer is replaced by the request ULID at acceptance, and the delivery is still accepted', () =>
  withQueue(({ dirs, launcher, queue }) => {
    const result = queue.enqueue({
      ...req('nightly:42'),
      event: {
        source: 'github',
        event: 'issue_comment.created',
        id: 'd-1\nE-Trigger: forged',
      },
      payload: {
        repository: { full_name: 'octo/repo' },
        issue: { number: 42, title: '@everyone look' },
      },
    });
    assert.equal(result.status, 'enqueued');
    const [entry] = listLedger(dirs);
    const ulid = entry.id.slice('trg-'.length);
    // Written validated: the file on disk never held the forged id.
    assert.deepEqual(entry.request?.event, {
      source: 'github',
      event: 'issue_comment.created',
      id: ulid,
    });
    assert.equal(
      entry.request?.eventUrl,
      'https://github.com/octo/repo/issues/42'
    );
    const [launch] = launcher.launches;
    assert.equal(launch.env[Env.TRIGGER_VAR], 'nightly');
    assert.equal(
      launch.env[Env.EVENT_VAR],
      `github:issue_comment.created:${ulid}`
    );
    assert.equal(
      launch.env[Env.EVENT_URL_VAR],
      'https://github.com/octo/repo/issues/42'
    );
  }));

test('provenance: a well-formed event id is the source identity, kept as it came', () =>
  withQueue(({ launcher, queue }) => {
    queue.enqueue(req('nightly:1'));
    assert.equal(
      launcher.launches[0].env[Env.EVENT_VAR],
      'cron:tick:20260918T0300Z'
    );
    assert.equal(launcher.launches[0].env[Env.EVENT_URL_VAR], undefined);
  }));

test('tick: due triggers are the first step, and what they enqueue fills a slot the same tick', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'e-queue-'));
  try {
    const dirs = runsDirs(store);
    const launcher = new ScriptedLauncher();
    const seen: string[] = [];
    let queue: RunQueue | undefined = undefined;
    queue = new RunQueue({
      dirs,
      config: DEFAULT_QUEUE_CONFIG,
      containerRunning: () => false,
      launch: launcher.launch,
      now: () => new Date('2026-09-18T03:00:20Z'),
      dueTriggers: now => {
        seen.push(now.toISOString());
        queue!.enqueue(req('nightly:20260918T0300Z'));
      },
    });
    queue.tick();
    assert.deepEqual(seen, ['2026-09-18T03:00:20.000Z']);
    assert.equal(launcher.launches.length, 1);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('tick: a scheduler that throws is logged and the queue still ticks', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'e-queue-'));
  try {
    const dirs = runsDirs(store);
    const launcher = new ScriptedLauncher();
    const queue = new RunQueue({
      dirs,
      config: DEFAULT_QUEUE_CONFIG,
      containerRunning: () => false,
      launch: launcher.launch,
      dueTriggers: () => {
        throw new Error('boom');
      },
    });
    queue.enqueue(req('t:1'));
    assert.doesNotThrow(() => queue.tick());
    assert.equal(launcher.launches.length, 1);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('triggerActivity: the last accepted request per trigger, in memory since the queue started; a rejection records nothing', () =>
  withQueue(
    ({ queue }) => {
      assert.match(queue.startedAt, /^\d{4}-\d\d-\d\dT/);
      assert.equal(queue.triggerActivity('t'), undefined);
      const first = queue.enqueue(req('t:1'));
      assert.equal(first.status, 'enqueued');
      const second = queue.enqueue(req('t:2'));
      assert.equal(second.status, 'enqueued');
      assert.equal(queue.enqueue(req('t:3')).status, 'full');
      const activity = queue.triggerActivity('t');
      assert.equal(
        activity?.lastRequestId,
        second.status === 'enqueued' ? second.request.id : ''
      );
      assert.ok(activity?.lastFiredAt);
    },
    { ...DEFAULT_QUEUE_CONFIG, slots: 0, maxLength: 2 }
  ));

test('tick: the age cap sweeps dead/ on the tick', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'e-queue-'));
  try {
    const dirs = runsDirs(store);
    let now = new Date('2026-09-18T03:00:00Z');
    const queue = new RunQueue({
      dirs,
      config: { ...DEFAULT_QUEUE_CONFIG, slots: 0, maxLength: 0 },
      dead: { maxAgeMs: 60_000, maxCount: 100 },
      containerRunning: () => false,
      now: () => now,
    });
    assert.equal(queue.enqueue(req('t:1')).status, 'full');
    assert.equal(listDead(dirs).length, 1);
    now = new Date('2026-09-18T03:02:00Z');
    queue.tick();
    assert.deepEqual(listDead(dirs), []);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('a request with a repo resolves its base there and starts its e spawn in it, on the serving Store (#201)', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'e-queue-'));
  try {
    const dirs = runsDirs(store);
    const launcher = new ScriptedLauncher();
    const asked: [string | undefined, string | undefined][] = [];
    const queue = new RunQueue({
      dirs,
      config: DEFAULT_QUEUE_CONFIG,
      containerRunning: () => false,
      launch: launcher.launch,
      servingRoot: '/home/me',
      resolveBase: (name, repo) => {
        asked.push([name, repo]);
        return {
          ref: 'refs/remotes/origin/main',
          sha: 'abc1234',
          branch: 'main',
        };
      },
    });
    queue.enqueue({ ...req('t:far'), repo: '/home/me/projects/e' });
    queue.enqueue(req('t:here'));
    assert.deepEqual(asked, [
      [undefined, '/home/me/projects/e'],
      [undefined, undefined],
    ]);
    const [far, here] = launcher.launches;
    assert.equal(far.cwd, '/home/me/projects/e');
    assert.deepEqual(far.args.slice(0, 4), [
      'spawn',
      'pi',
      '--dir',
      '/home/me',
    ]);
    // A request of the serving repository runs where serve does, as before.
    assert.equal(here.cwd, undefined);
    assert.ok(!here.args.includes('--dir'));
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});
