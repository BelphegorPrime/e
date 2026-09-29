import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redrive, type RedriveDeps } from './redrive.js';
import {
  enqueueRequest,
  listQueue,
  newRequestId,
  readDeadRequest,
  runsDirs,
  writeDeadRequest,
  type RunRequest,
} from './runsSpool.js';

/*
 * `e trigger redrive <id>` (ADR-0016 section 6): human-only, a fresh
 * acceptance against the current declaration, refused where it would lose
 * or duplicate something.
 */

function withStore(
  fn: (ctx: {
    deps: RedriveDeps;
    write: (body: object | undefined) => void;
    bury: (overrides?: Partial<RunRequest>) => RunRequest;
  }) => void
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-redrive-'));
  const dirs = runsDirs(path.join(root, '.e'));
  const deps: RedriveDeps = {
    dirs,
    store: { root, context: () => ({}) },
    maxLength: 10,
    now: () => new Date('2026-09-30T08:00:00Z'),
  };
  const write = (body: object | undefined): void => {
    const dir = path.join(root, '.e', 'triggers', 'fix');
    if (body === undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'trigger.json'), JSON.stringify(body));
  };
  const bury = (overrides: Partial<RunRequest> = {}): RunRequest => {
    const request: RunRequest = {
      id: newRequestId(),
      key: 'fix:d-1',
      trigger: 'fix',
      agent: 'pi',
      prompt: 'the old prompt',
      event: { source: 'github', event: 'issues', id: 'd-1' },
      payload: {
        action: 'labeled',
        issue: { number: 42 },
        label: { name: 'agent' },
      },
      enqueuedAt: '2026-09-27T08:00:00.000Z',
      ...overrides,
    };
    writeDeadRequest(dirs, {
      request,
      stage: 'expired',
      reason: 'ttl',
      diedAt: '2026-09-28T08:00:00.000Z',
    });
    return request;
  };
  try {
    fn({ deps, write, bury });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const declaration = (overrides: object = {}): object => ({
  agent: 'codex',
  prompt: 'Fix #{{issue.number}}, again',
  on: { type: 'webhook', source: 'github', event: 'issues', action: 'labeled' },
  ...overrides,
});

test('redrive: the current prompt and agent take effect; the request is back in queue/ with a fresh TTL, its dead record gone', () =>
  withStore(({ deps, write, bury }) => {
    write(declaration());
    const dead = bury();
    const result = redrive(deps, dead.id);
    assert.equal(result.status, 'redriven');
    const [queued] = listQueue(deps.dirs);
    // A fresh acceptance: a new id, so it queues behind what already waits.
    assert.notEqual(queued.id, dead.id);
    assert.match(queued.id, /^trg-/);
    assert.equal(queued.agent, 'codex');
    assert.equal(queued.prompt, 'Fix #42, again');
    assert.equal(queued.enqueuedAt, '2026-09-30T08:00:00.000Z');
    assert.deepEqual(queued.event, dead.event);
    assert.equal(readDeadRequest(deps.dirs, dead.id), undefined);
  }));

test('redrive: a changed match takes effect and refuses; a disabled or deleted trigger refuses', () =>
  withStore(({ deps, write, bury }) => {
    const dead = bury();
    write(
      declaration({
        on: {
          type: 'webhook',
          source: 'github',
          event: 'issues',
          action: 'labeled',
          match: { 'label.name': 'bug' },
        },
      })
    );
    assert.match(
      (redrive(deps, dead.id) as { reason: string }).reason,
      /no longer matches/
    );
    write(declaration({ enabled: false }));
    assert.match(
      (redrive(deps, dead.id) as { reason: string }).reason,
      /disabled/
    );
    write(undefined);
    assert.match(
      (redrive(deps, dead.id) as { reason: string }).reason,
      /was deleted/
    );
    // Every refusal kept the record.
    assert.ok(readDeadRequest(deps.dirs, dead.id));
  }));

test('redrive: refused while its key is pending, naming the pending entry', () =>
  withStore(({ deps, write, bury }) => {
    write(declaration());
    const dead = bury();
    const pending: RunRequest = {
      ...dead,
      id: newRequestId(),
      enqueuedAt: '2026-09-30T07:00:00.000Z',
    };
    enqueueRequest(deps.dirs, pending, 10);
    const result = redrive(deps, dead.id);
    assert.equal(result.status, 'refused');
    assert.match(
      (result as { reason: string }).reason,
      new RegExp(`fix:d-1 is already pending as ${pending.id}`)
    );
    assert.ok(readDeadRequest(deps.dirs, dead.id));
  }));

test('redrive: an unknown id, a broken trigger and a full queue refuse', () =>
  withStore(({ deps, write, bury }) => {
    assert.match(
      (redrive(deps, 'trg-01K00000000000000000000000') as { reason: string })
        .reason,
      /no dead request/
    );
    const dead = bury();
    write({
      agent: 'pi',
      prompt: 'p',
      on: { type: 'cron', expr: '61 * * * *' },
    });
    assert.match(
      (redrive(deps, dead.id) as { reason: string }).reason,
      /does not load/
    );
    write(declaration());
    const full = redrive({ ...deps, maxLength: 0 }, dead.id);
    assert.match((full as { reason: string }).reason, /queue is full/);
  }));
