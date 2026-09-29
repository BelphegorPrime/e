import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Env } from '../../shared/utils/env.js';
import { DEFAULT_QUEUE_CONFIG } from '../../core/store/config.js';
import type { ChildLaunch, ChildLauncher } from '../runs/childRun.js';
import { RunQueue, type NewRunRequest } from './runQueue.js';
import {
  listLedger,
  listQueue,
  newRequestId,
  patchLedgerFile,
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
  config = DEFAULT_QUEUE_CONFIG
): Promise<T> {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'e-queue-'));
  try {
    const dirs = runsDirs(store);
    const launcher = new ScriptedLauncher();
    const running = new Set<string>();
    const queue = new RunQueue({
      dirs,
      config,
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

test('a child that exits without ending its entry is failed, and its slot freed', () =>
  withQueue(async ({ dirs, launcher, queue }) => {
    queue.enqueue(req('t:1'));
    const id = launcher.launches[0].request.id;
    await launcher.exit(id, 1);
    const entry = readLedgerEntry(dirs, id);
    assert.equal(entry?.state, 'failed');
    assert.equal(entry?.exitCode, 1);
    assert.match(
      entry?.error ?? '',
      /exited with code 1 before ending its run/
    );
    assert.equal(queue.heldSlots(), 0);
  }));

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
