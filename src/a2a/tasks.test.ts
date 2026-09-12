import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRequest, readStatus, writeStatus } from '../broker/spool.js';
import { Env } from '../utils/env.js';
import { JsonRpcError } from './jsonRpc.js';
import {
  A2aTasks,
  parseSendParams,
  requestedAgent,
  type TaskChild,
} from './tasks.js';
import type { WireStreamResult, WireTask } from './wire.js';

/** The `e spawn` children the test controls: it plays each run by writing its status. */
class FakeChildren {
  launches: Array<{ args: string[]; env: Record<string, string | undefined> }> =
    [];
  killed: number[] = [];
  private readonly exits: Array<(code: number) => void> = [];

  spawn = (
    args: string[],
    env: Record<string, string | undefined>
  ): TaskChild => {
    const index = this.launches.length;
    this.launches.push({ args, env });
    const exited = new Promise<number>(resolve => {
      this.exits[index] = resolve;
    });
    return { exited, kill: () => this.killed.push(index) };
  };

  async exit(index: number, code: number): Promise<void> {
    this.exits[index](code);
    await new Promise(resolve => setImmediate(resolve));
  }
}

function withTasks<T>(
  fn: (tasks: A2aTasks, children: FakeChildren, spool: string) => Promise<T>
): Promise<T> {
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), 'e-a2a-tasks-'));
  const children = new FakeChildren();
  let counter = 0;
  const tasks = new A2aTasks({
    spoolDir: spool,
    knownAgent: name => ['pi', 'smart-codex'].includes(name),
    defaultAgent: 'pi',
    spawnChild: children.spawn,
    pollIntervalMs: 60_000, // driven by hand through tick()
    now: () => new Date('2026-09-12T10:00:00.000Z'),
    newId: () => `id-${++counter}`,
  });
  return fn(tasks, children, spool).finally(() => {
    tasks.dispose();
    fs.rmSync(spool, { recursive: true, force: true });
  });
}

const send = (text: string, metadata?: Record<string, unknown>) => ({
  message: {
    messageId: 'm-1',
    role: 'ROLE_USER',
    parts: [{ text }],
    ...(metadata ? { metadata } : {}),
  },
});

test('requestedAgent / parseSendParams: the agent from metadata.agent or skillId, default otherwise; the errors the spec names', () => {
  assert.equal(requestedAgent(send('x', { agent: 'pi' })), 'pi');
  assert.equal(
    requestedAgent(send('x', { skillId: 'smart-codex' })),
    'smart-codex'
  );
  assert.equal(
    requestedAgent({ ...send('x'), metadata: { agent: 'pi' } }),
    'pi'
  );
  assert.equal(requestedAgent(send('x')), undefined);
  const known = (name: string) => name === 'pi';
  assert.equal(parseSendParams(send('do it'), known, 'pi').agent, 'pi');
  assert.equal(
    parseSendParams(send('do it'), known, 'pi').message.role,
    'ROLE_USER'
  );
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return (err as JsonRpcError).code;
    }
    return undefined;
  };
  assert.equal(
    code(() => parseSendParams({}, known, 'pi')),
    -32602
  );
  assert.equal(
    code(() => parseSendParams({ message: { parts: 'x' } }, known, 'pi')),
    -32602
  );
  assert.equal(
    code(() =>
      parseSendParams({ message: { parts: [{ data: { a: 1 } }] } }, known, 'pi')
    ),
    -32005
  );
  assert.equal(
    code(() => parseSendParams(send('x', { agent: 'nope' }), known, 'pi')),
    -32602
  );
  assert.equal(
    code(() =>
      parseSendParams(
        { message: { ...send('x').message, taskId: 't' } },
        known,
        'pi'
      )
    ),
    -32004
  );
  assert.equal(
    code(() =>
      parseSendParams(
        { ...send('x'), configuration: { taskPushNotificationConfig: {} } },
        known,
        'pi'
      )
    ),
    -32003
  );
});

test('send: spools the request, starts `e spawn <agent> -- <prompt>` with the report markers, answers a submitted task', async () => {
  await withTasks(async (tasks, children, spool) => {
    const task = tasks.send(
      send('Fix the flaky test', { agent: 'smart-codex' })
    );
    assert.equal(task.id, 'id-1');
    assert.equal(task.contextId, 'id-2');
    assert.equal(task.status.state, 'TASK_STATE_SUBMITTED');
    assert.deepEqual(task.metadata, {
      agent: 'smart-codex',
      requestId: 'a2a-001',
    });
    assert.deepEqual(task.history?.[0].parts, [{ text: 'Fix the flaky test' }]);
    assert.equal(task.history?.[0].taskId, 'id-1');
    assert.deepEqual(children.launches[0].args, [
      'spawn',
      'smart-codex',
      '--',
      'Fix the flaky test',
    ]);
    assert.equal(children.launches[0].env[Env.SPAWN_REPORT_SPOOL_VAR], spool);
    assert.equal(children.launches[0].env[Env.SPAWN_REPORT_ID_VAR], 'a2a-001');
    assert.equal(children.launches[0].env[Env.SERVE_DETACHED_VAR], undefined);
    assert.equal(readRequest(spool, 'a2a-001')?.agent, 'smart-codex');
    // The default agent when none is named; the second task gets the next id.
    const second = tasks.send(send('Another'));
    assert.equal(second.metadata?.agent, 'pi');
    assert.equal(second.metadata?.requestId, 'a2a-002');
    assert.deepEqual(
      tasks.list().map(t => t.id),
      ['id-1', 'id-3']
    );
  });
});

test('a run reporting into the spool moves the task: working with the branch, then completed with the run artifact and final events', async () => {
  await withTasks(async (tasks, children, spool) => {
    const task = tasks.send(send('Fix it', { agent: 'pi' }));
    const events: WireStreamResult[] = [];
    tasks.subscribe(task.id, event => events.push(event));

    writeStatus(spool, 'a2a-001', {
      status: 'running',
      branch: 'e/pi/fix-it-1',
      updatedAt: 't1',
    });
    tasks.tick();
    assert.equal(tasks.get(task.id).status.state, 'TASK_STATE_WORKING');
    assert.equal(tasks.get(task.id).metadata?.branch, 'e/pi/fix-it-1');
    assert.equal(events.length, 1);
    assert.ok('statusUpdate' in events[0]);
    if (!('statusUpdate' in events[0])) throw new Error('unreachable');
    assert.equal(events[0].statusUpdate.status.state, 'TASK_STATE_WORKING');
    assert.equal(events[0].statusUpdate.final, false);
    // Same state again: no event.
    tasks.tick();
    assert.equal(events.length, 1);

    writeStatus(spool, 'a2a-001', {
      status: 'done',
      branch: 'e/pi/fix-it-1',
      exitCode: 0,
      pushed: true,
      pullRequestUrl: 'https://example.com/pr/1',
      updatedAt: 't2',
    });
    await children.exit(0, 0);
    const done: WireTask = tasks.get(task.id);
    assert.equal(done.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(done.status.timestamp, 't2');
    assert.equal(done.artifacts?.length, 1);
    assert.equal(done.artifacts?.[0].name, 'run');
    assert.deepEqual(done.artifacts?.[0].parts[0], {
      data: {
        branch: 'e/pi/fix-it-1',
        exitCode: 0,
        pushed: true,
        pullRequestUrl: 'https://example.com/pr/1',
      },
      mediaType: 'application/json',
    });
    assert.match(
      done.artifacts?.[0].parts[1].text ?? '',
      /pushed.*Pull\/merge request: https:\/\/example\.com\/pr\/1/
    );
    // Final events: the artifact, then the final status update; listeners are then dropped.
    assert.equal(events.length, 3);
    assert.ok('artifactUpdate' in events[1]);
    assert.ok(
      'statusUpdate' in events[2] && events[2].statusUpdate.final === true
    );
    // A late subscriber to a finished task gets the final events at once.
    const late: WireStreamResult[] = [];
    tasks.subscribe(task.id, event => late.push(event));
    assert.equal(late.length, 2);
  });
});

test('a run that exits non-zero is failed with the reason; a process that dies without reporting is failed too', async () => {
  await withTasks(async (tasks, children, spool) => {
    const a = tasks.send(send('a', { agent: 'pi' }));
    writeStatus(spool, 'a2a-001', {
      status: 'done',
      branch: 'b',
      exitCode: 2,
      updatedAt: 't',
    });
    await children.exit(0, 2);
    const failed = tasks.get(a.id);
    assert.equal(failed.status.state, 'TASK_STATE_FAILED');
    assert.match(
      failed.status.message?.parts[0].text ?? '',
      /exited with code 2; nothing was committed/
    );
    assert.equal(failed.artifacts, undefined);

    const b = tasks.send(send('b', { agent: 'pi' }));
    await children.exit(1, 1);
    assert.equal(tasks.get(b.id).status.state, 'TASK_STATE_FAILED');
    assert.match(
      tasks.get(b.id).status.message?.parts[0].text ?? '',
      /exited with code 1 before reporting a result/
    );
    assert.equal(readStatus(spool, 'a2a-002')?.status, 'failed');
  });
});

test('cancel: stops the child and reports canceled when it exits, whatever it reported; a finished task is not cancelable; unknown ids are TaskNotFound', async () => {
  await withTasks(async (tasks, children, spool) => {
    const task = tasks.send(send('long', { agent: 'pi' }));
    writeStatus(spool, 'a2a-001', {
      status: 'running',
      branch: 'b',
      updatedAt: 't',
    });
    const canceling = tasks.cancel(task.id);
    assert.equal(canceling.status.state, 'TASK_STATE_WORKING');
    assert.deepEqual(children.killed, [0]);
    tasks.cancel(task.id); // idempotent while it stops
    assert.deepEqual(children.killed, [0]);
    writeStatus(spool, 'a2a-001', {
      status: 'done',
      branch: 'b',
      exitCode: 137,
      updatedAt: 't',
    });
    await children.exit(0, 137);
    const canceled = tasks.get(task.id);
    assert.equal(canceled.status.state, 'TASK_STATE_CANCELED');
    assert.equal(
      canceled.status.message?.parts[0].text,
      'canceled by the A2A client'
    );
    assert.equal(readStatus(spool, 'a2a-001')?.branch, 'b');
    assert.throws(
      () => tasks.cancel(task.id),
      (err: unknown) => (err as JsonRpcError).code === -32002
    );
    assert.throws(
      () => tasks.get('nope'),
      (err: unknown) => (err as JsonRpcError).code === -32001
    );
    assert.throws(
      () => tasks.cancel(undefined),
      (err: unknown) => (err as JsonRpcError).code === -32001
    );
  });
});
