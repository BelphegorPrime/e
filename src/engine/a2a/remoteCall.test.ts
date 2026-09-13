import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callRemoteAgent, type RemoteCallClient } from './remoteCall.js';
import { toWireState } from './wire.js';
import type { WireTask } from './wire.js';
import type { RemoteA2aAgent } from '../../core/agent/remoteAgent.js';
import type { TaskState } from '../../sidecars/broker/contract/types.js';

const agent: RemoteA2aAgent = {
  name: 'researcher',
  transport: 'a2a',
  url: 'https://remote.test/a2a',
};

/** A task in `state`, answering with `answer` as its one artifact. */
function task(state: TaskState, answer = ''): WireTask {
  return {
    id: 'task-1',
    contextId: 'ctx-1',
    status: { state: toWireState(state) },
    ...(answer
      ? { artifacts: [{ artifactId: 'a', parts: [{ text: answer }] }] }
      : {}),
  } as WireTask;
}

/** Records what the call did and answers from a script. */
function client(script: {
  send?: () => Promise<unknown>;
  wait?: (signal?: AbortSignal) => Promise<WireTask>;
}): RemoteCallClient & { canceled: string[]; sent: unknown[] } {
  const canceled: string[] = [];
  const sent: unknown[] = [];
  return {
    canceled,
    sent,
    sendMessage: (async (_endpoint, text, metadata) => {
      sent.push({ text, metadata });
      return script.send
        ? await script.send()
        : { kind: 'task', task: task('working') };
    }) as RemoteCallClient['sendMessage'],
    waitForTask: (async (_endpoint, _task, options) => {
      return script.wait
        ? await script.wait(options?.signal)
        : task('completed');
    }) as RemoteCallClient['waitForTask'],
    cancelTask: (async (_endpoint, id) => {
      canceled.push(id);
      return { ok: true };
    }) as RemoteCallClient['cancelTask'],
  };
}

const call = (c: RemoteCallClient, over: Record<string, unknown> = {}) =>
  callRemoteAgent({
    agent,
    prompt: 'look into X',
    storeEnv: {},
    client: c,
    ...over,
  });

test('a direct message reply never opens a task', async () => {
  const c = client({
    send: async () => ({
      kind: 'message',
      message: { parts: [{ text: 'here you go' }] },
    }),
  });
  assert.deepEqual(await call(c), { kind: 'answer', answer: 'here you go' });
  assert.deepEqual(c.canceled, []);
});

for (const state of [
  'completed',
  'input-required',
  'canceled',
  'rejected',
  'failed',
] as const) {
  test(`a task that settles as ${state} is reported with its state and answer`, async () => {
    const c = client({ wait: async () => task(state, `said ${state}`) });
    assert.deepEqual(await call(c), {
      kind: 'settled',
      taskId: 'task-1',
      state,
      answer: `said ${state}`,
    });
  });
}

test('a settled task with nothing to say answers with an empty string, not undefined', async () => {
  const c = client({ wait: async () => task('completed') });
  const outcome = await call(c);
  assert.equal(outcome.kind, 'settled');
  assert.equal(outcome.kind === 'settled' && outcome.answer, '');
});

test('an abort cancels the remote task and reports canceled', async () => {
  const controller = new AbortController();
  const c = client({
    wait: async signal => {
      // The remote is still working when the caller gives up.
      controller.abort();
      assert.equal(signal?.aborted, true, 'the wait gets the signal');
      return task('working', 'partial');
    },
  });
  const outcome = await call(c, { signal: controller.signal });
  assert.deepEqual(outcome, {
    kind: 'canceled',
    taskId: 'task-1',
    answer: 'partial',
  });
  assert.deepEqual(
    c.canceled,
    ['task-1'],
    'the remote must be told, or it keeps working'
  );
});

test('an abort before the task exists cancels nothing', async () => {
  const controller = new AbortController();
  const c = client({
    send: async () => {
      controller.abort();
      throw new Error('aborted');
    },
  });
  const outcome = await call(c, { signal: controller.signal });
  assert.equal(outcome.kind, 'failed');
  assert.deepEqual(c.canceled, [], 'there is no task id to cancel yet');
});

test('an unresolved ${VAR} in the headers fails the call instead of throwing', async () => {
  const c = client({});
  const outcome = await callRemoteAgent({
    agent: { ...agent, headers: { Authorization: 'Bearer ${MISSING_KEY}' } },
    prompt: 'go',
    storeEnv: {},
    client: c,
  });
  assert.equal(outcome.kind, 'failed');
  assert.match(
    outcome.kind === 'failed' ? outcome.error : '',
    /MISSING_KEY/,
    'the message must name the variable that is unset'
  );
  assert.deepEqual(c.sent, [], 'nothing is sent without resolved headers');
});

test('a transport failure is an outcome, not an exception', async () => {
  const c = client({
    send: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.deepEqual(await call(c), {
    kind: 'failed',
    error: 'ECONNREFUSED',
  });
});

test('a failure while waiting is an outcome too', async () => {
  const c = client({
    wait: async () => {
      throw new Error('the stream died');
    },
  });
  const outcome = await call(c);
  assert.equal(outcome.kind, 'failed');
});

test('the request id travels as metadata so the remote can correlate it', async () => {
  const c = client({});
  await call(c, { requestId: 'sib-007' });
  assert.deepEqual(c.sent, [
    { text: 'look into X', metadata: { source: 'e', requestId: 'sib-007' } },
  ]);
});

test('without a request id the metadata carries only the source', async () => {
  const c = client({});
  await call(c);
  assert.deepEqual(c.sent, [
    { text: 'look into X', metadata: { source: 'e' } },
  ]);
});

test('an abort while the prompt is in flight still cancels the remote task', async () => {
  // The window this closes: the server has the prompt as soon as it reads the
  // request, but `taskId` is only known once the response comes back. An abort
  // in between used to find no id, send no cancel, and leave the remote
  // working for nobody. Reproduced under load as a 30s hang in the A2A interop
  // test, waiting for a cancel that was never sent.
  const controller = new AbortController();
  const c = client({
    send: async () => {
      controller.abort();
      return { kind: 'task', task: task('working') };
    },
    wait: async () => {
      throw new Error('waitForTask must not be reached after an early abort');
    },
  });
  const outcome = await call(c, { signal: controller.signal });
  assert.deepEqual(outcome, { kind: 'canceled', taskId: 'task-1', answer: '' });
  assert.deepEqual(
    c.canceled,
    ['task-1'],
    'the remote must be told even though the abort beat the task id'
  );
});
