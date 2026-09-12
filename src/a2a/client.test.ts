import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureSpool,
  readRecord,
  readStatus,
  writeRequest,
} from '../broker/spool.js';
import {
  A2aClient,
  A2aRemoteError,
  isSettled,
  taskAnswer,
  wireTaskState,
} from './client.js';
import {
  INPUT_REQUIRED_MESSAGE,
  remoteSiblingProcess,
} from './remoteSibling.js';
import { runRemoteAgent } from './remoteSpawn.js';
import type { RemoteA2aAgent } from './remoteAgent.js';
import type { WireTask } from './wire.js';

/**
 * A scripted remote agent: answers each JSON-RPC method from a queue of
 * results (or errors), and records what it was asked.
 */
class FakeRemote {
  calls: Array<{
    method: string;
    params: unknown;
    headers: Record<string, string>;
  }> = [];
  private readonly script = new Map<string, Array<unknown | Error>>();

  on(method: string, ...results: Array<unknown | Error>): this {
    this.script.set(method, [...(this.script.get(method) ?? []), ...results]);
    return this;
  }

  fetch: typeof fetch = (async (
    _url: string | URL | Request,
    init?: RequestInit
  ) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown;
      id: string;
    };
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>)
    );
    this.calls.push({ method: body.method, params: body.params, headers });
    const queue = this.script.get(body.method) ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const payload =
      next instanceof Error
        ? {
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32001, message: next.message },
          }
        : { jsonrpc: '2.0', id: body.id, result: next ?? null };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const task = (state: string, extra: Partial<WireTask> = {}): WireTask => ({
  id: 'rt-1',
  contextId: 'ctx',
  status: { state },
  ...extra,
});

const endpoint = {
  url: 'https://remote.example/a2a',
  headers: { Authorization: 'Bearer t' },
};

test('A2aClient.sendMessage: posts a 1.0 message with the version header; a {task} result is followed with GetTask until settled', async () => {
  const remote = new FakeRemote()
    .on('SendMessage', { task: task('TASK_STATE_SUBMITTED') })
    .on('GetTask', task('TASK_STATE_WORKING'), {
      task: task('TASK_STATE_COMPLETED', {
        artifacts: [{ artifactId: 'a', parts: [{ text: 'The answer' }] }],
      }),
    });
  const client = new A2aClient({
    fetchImpl: remote.fetch,
    newId: () => 'msg-1',
  });
  const sent = await client.sendMessage(endpoint, 'What is X?', {
    source: 'e',
  });
  assert.equal(sent.kind, 'task');
  assert.deepEqual(remote.calls[0].params, {
    message: {
      messageId: 'msg-1',
      role: 'ROLE_USER',
      parts: [{ text: 'What is X?' }],
      metadata: { source: 'e' },
    },
    configuration: { returnImmediately: true },
  });
  assert.equal(remote.calls[0].headers['A2A-Version'], '1.0');
  assert.equal(remote.calls[0].headers.Authorization, 'Bearer t');
  if (sent.kind !== 'task') throw new Error('unreachable');
  const sleeps: number[] = [];
  const done = await client.waitForTask(endpoint, sent.task, {
    pollMs: 7,
    sleep: async ms => {
      sleeps.push(ms);
    },
  });
  assert.equal(wireTaskState(done), 'completed');
  assert.equal(taskAnswer(done), 'The answer');
  assert.deepEqual(sleeps, [7, 7]);
  assert.deepEqual(
    remote.calls.map(c => c.method),
    ['SendMessage', 'GetTask', 'GetTask']
  );
});

test('A2aClient: a direct message answer, a JSON-RPC error, a non-JSON body, and cancel outcomes', async () => {
  const remote = new FakeRemote()
    .on('SendMessage', {
      message: { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text: '42' }] },
    })
    .on('GetTask', new Error('no such task'))
    .on('CancelTask', new Error('already done'));
  const client = new A2aClient({ fetchImpl: remote.fetch });
  const sent = await client.sendMessage(endpoint, 'q');
  assert.equal(sent.kind, 'message');
  await assert.rejects(client.getTask(endpoint, 'x'), (err: unknown) => {
    assert.ok(err instanceof A2aRemoteError);
    assert.equal(err.code, -32001);
    return true;
  });
  assert.deepEqual(await client.cancelTask(endpoint, 'x'), {
    ok: false,
    error: 'already done',
  });
  const html = new A2aClient({
    fetchImpl: (async () =>
      new Response('<html>', { status: 502 })) as typeof fetch,
  });
  await assert.rejects(
    html.getTask(endpoint, 'x'),
    /HTTP 502 with a non-JSON body/
  );
  assert.equal(isSettled('working'), false);
  assert.equal(isSettled('input-required'), true);
  assert.equal(
    taskAnswer(
      task('TASK_STATE_FAILED', {
        status: {
          state: 'TASK_STATE_FAILED',
          message: {
            messageId: 'm',
            role: 'ROLE_AGENT',
            parts: [{ text: 'why' }],
          },
        },
      })
    ),
    'why'
  );
});

const remoteAgent: RemoteA2aAgent = {
  name: 'remote',
  transport: 'a2a',
  url: 'https://remote.example/a2a',
  headers: { Authorization: 'Bearer ${TOKEN}' },
};

const request = {
  id: 'sib-001',
  agent: 'remote',
  prompt: 'What is X?',
  requestedAt: 't',
};

function withSpool<T>(fn: (spool: string) => Promise<T>): Promise<T> {
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), 'e-remote-sib-'));
  ensureSpool(spool);
  for (const id of ['sib-001', 'sib-002', 'sib-003', 'sib-004']) {
    writeRequest(spool, { ...request, id });
  }
  return fn(spool).finally(() =>
    fs.rmSync(spool, { recursive: true, force: true })
  );
}

test('remoteSiblingProcess: running, then done with the answer; the merge-back has nothing to merge', async () => {
  await withSpool(async spool => {
    const remote = new FakeRemote()
      .on('SendMessage', { task: task('TASK_STATE_WORKING') })
      .on(
        'GetTask',
        task('TASK_STATE_COMPLETED', {
          artifacts: [{ artifactId: 'a', parts: [{ text: 'X is 42.' }] }],
        })
      );
    const proc = remoteSiblingProcess({
      agent: remoteAgent,
      request,
      spoolDir: spool,
      storeEnv: { TOKEN: 'abc' },
      client: new A2aClient({ fetchImpl: remote.fetch }),
      pollMs: 1,
      sleep: async () => {},
      now: () => new Date('2026-09-12T10:00:00.000Z'),
    });
    assert.equal(await proc.exited, 0);
    const status = readStatus(spool, 'sib-001');
    assert.equal(status?.status, 'done');
    assert.equal(status?.exitCode, 0);
    assert.equal(status?.answer, 'X is 42.');
    assert.equal(status?.branch, undefined);
    assert.equal(remote.calls[0].headers.Authorization, 'Bearer abc');
    assert.deepEqual(
      (remote.calls[0].params as { message: { metadata: unknown } }).message
        .metadata,
      {
        source: 'e',
        requestId: 'sib-001',
      }
    );
    assert.equal(readRecord(spool, 'sib-001')?.taskState, 'completed');
  });
});

test('remoteSiblingProcess: a question back, a failure, an unresolved header, and a cancel are failures with the reason', async () => {
  await withSpool(async spool => {
    const asks = new FakeRemote().on('SendMessage', {
      task: task('TASK_STATE_INPUT_REQUIRED', {
        status: {
          state: 'TASK_STATE_INPUT_REQUIRED',
          message: {
            messageId: 'm',
            role: 'ROLE_AGENT',
            parts: [{ text: 'Which X?' }],
          },
        },
      }),
    });
    const asked = remoteSiblingProcess({
      agent: remoteAgent,
      request,
      spoolDir: spool,
      storeEnv: { TOKEN: 'abc' },
      client: new A2aClient({ fetchImpl: asks.fetch }),
      sleep: async () => {},
    });
    assert.equal(await asked.exited, 1);
    assert.equal(readStatus(spool, 'sib-001')?.status, 'failed');
    assert.equal(readStatus(spool, 'sib-001')?.error, INPUT_REQUIRED_MESSAGE);
    assert.equal(readStatus(spool, 'sib-001')?.answer, 'Which X?');

    const failing = new FakeRemote().on(
      'SendMessage',
      new Error('quota exceeded')
    );
    const failed = remoteSiblingProcess({
      agent: remoteAgent,
      request: { ...request, id: 'sib-002' },
      spoolDir: spool,
      storeEnv: { TOKEN: 'abc' },
      client: new A2aClient({ fetchImpl: failing.fetch }),
    });
    assert.equal(await failed.exited, 1);
    assert.match(
      readStatus(spool, 'sib-002')?.error ?? '',
      /remote agent remote: quota exceeded/
    );

    const hole = remoteSiblingProcess({
      agent: remoteAgent,
      request: { ...request, id: 'sib-003' },
      spoolDir: spool,
      storeEnv: {},
      client: new A2aClient({ fetchImpl: failing.fetch }),
    });
    assert.equal(await hole.exited, 1);
    assert.match(
      readStatus(spool, 'sib-003')?.error ?? '',
      /references \$\{TOKEN\}/
    );

    // Cancel: the poll loop is aborted and the remote task canceled.
    const slow = new FakeRemote()
      .on('SendMessage', { task: task('TASK_STATE_WORKING') })
      .on('GetTask', task('TASK_STATE_WORKING'))
      .on('CancelTask', { task: task('TASK_STATE_CANCELED') });
    const canceled = remoteSiblingProcess({
      agent: remoteAgent,
      request: { ...request, id: 'sib-004' },
      spoolDir: spool,
      storeEnv: { TOKEN: 'abc' },
      client: new A2aClient({ fetchImpl: slow.fetch }),
      pollMs: 1,
      // The first poll is the cancel: the process is defined by then.
      sleep: async () => canceled.kill(),
    });
    assert.equal(await canceled.exited, 1);
    assert.equal(readStatus(spool, 'sib-004')?.error, 'canceled');
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(slow.calls.some(c => c.method === 'CancelTask'));
  });
});

test('runRemoteAgent (e spawn <remote> "<prompt>"): prints the answer and exits 0; a prompt is required; other outcomes exit 1', async () => {
  const printed: string[] = [];
  const remote = new FakeRemote()
    .on('SendMessage', { task: task('TASK_STATE_SUBMITTED') })
    .on(
      'GetTask',
      task('TASK_STATE_COMPLETED', {
        artifacts: [{ artifactId: 'a', parts: [{ text: 'Done: 42' }] }],
      })
    );
  const code = await runRemoteAgent({
    agent: remoteAgent,
    prompt: 'What is X?',
    storeEnv: { TOKEN: 'abc' },
    client: new A2aClient({ fetchImpl: remote.fetch }),
    pollMs: 1,
    sleep: async () => {},
    print: text => printed.push(text),
  });
  assert.equal(code, 0);
  assert.deepEqual(printed, ['Done: 42']);
  await assert.rejects(
    runRemoteAgent({ agent: remoteAgent, prompt: '  ', storeEnv: {} }),
    /takes a prompt and answers it/
  );
  const rejecting = new FakeRemote().on('SendMessage', {
    task: task('TASK_STATE_REJECTED'),
  });
  assert.equal(
    await runRemoteAgent({
      agent: remoteAgent,
      prompt: 'q',
      storeEnv: { TOKEN: 'abc' },
      client: new A2aClient({ fetchImpl: rejecting.fetch }),
      print: () => {},
    }),
    1
  );
});
