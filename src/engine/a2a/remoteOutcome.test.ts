/**
 * What each remote outcome *means* - the half `remoteCall.ts` deliberately
 * leaves to its two callers. They differ in one place that matters: a person
 * running `e spawn <remote>` can answer a question, a Sibling run cannot.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runRemoteAgent } from './remoteSpawn.js';
import {
  remoteSiblingProcess,
  INPUT_REQUIRED_MESSAGE,
} from './remoteSibling.js';
import type { RemoteCallClient } from './remoteCall.js';
import { toWireState } from './wire.js';
import type { WireTask } from './wire.js';
import type { RemoteA2aAgent } from '../../core/agent/remoteAgent.js';
import type { TaskState } from '../../sidecars/broker/contract/types.js';
import {
  ensureSpool,
  readStatus,
  writeRequest,
} from '../../sidecars/broker/contract/spool.js';

const agent: RemoteA2aAgent = {
  name: 'researcher',
  transport: 'a2a',
  url: 'https://remote.test/a2a',
};

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

/** A client that always settles into `state`. */
function settling(state: TaskState, answer = ''): RemoteCallClient {
  return {
    sendMessage: (async () => ({
      kind: 'task',
      task: task('working'),
    })) as RemoteCallClient['sendMessage'],
    waitForTask: (async () =>
      task(state, answer)) as RemoteCallClient['waitForTask'],
    cancelTask: (async () => ({ ok: true })) as RemoteCallClient['cancelTask'],
  };
}

function withSpool(fn: (spool: string) => Promise<void>): Promise<void> {
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), 'e-remote-outcome-'));
  ensureSpool(spool);
  writeRequest(spool, {
    id: 'sib-001',
    agent: 'researcher',
    prompt: 'look into X',
    requestedAt: 't',
  });
  return fn(spool).finally(() =>
    fs.rmSync(spool, { recursive: true, force: true })
  );
}

const sibling = (spool: string, client: RemoteCallClient) =>
  remoteSiblingProcess({
    agent,
    request: {
      id: 'sib-001',
      agent: 'researcher',
      prompt: 'look into X',
      requestedAt: 't',
    },
    spoolDir: spool,
    storeEnv: {},
    client,
  });

const spawned = (client: RemoteCallClient, printed: string[]) =>
  runRemoteAgent({
    agent,
    prompt: 'look into X',
    storeEnv: {},
    client: client as never,
    print: text => printed.push(text),
  });

test('completed: the spawn prints the answer and exits 0', async () => {
  const printed: string[] = [];
  assert.equal(await spawned(settling('completed', 'the answer'), printed), 0);
  assert.deepEqual(printed, ['the answer']);
});

test('completed: the sibling records the answer in its status and exits 0', async () => {
  await withSpool(async spool => {
    const handle = sibling(spool, settling('completed', 'the answer'));
    assert.equal(await handle.exited, 0);
    const status = readStatus(spool, 'sib-001');
    assert.equal(status?.status, 'done');
    assert.equal(status?.exitCode, 0);
    assert.equal(status?.answer, 'the answer');
  });
});

test('input-required: a person can answer, so the spawn only warns - and still exits 1', async () => {
  const printed: string[] = [];
  const code = await spawned(
    settling('input-required', 'which repository?'),
    printed
  );
  assert.equal(code, 1);
  // The question reaches the person who can answer it.
  assert.deepEqual(printed, ['which repository?']);
});

test('input-required: a sibling cannot answer, so it is a failure with the question kept', async () => {
  await withSpool(async spool => {
    const handle = sibling(
      spool,
      settling('input-required', 'which repository?')
    );
    assert.equal(await handle.exited, 1);
    const status = readStatus(spool, 'sib-001');
    assert.equal(status?.status, 'failed');
    assert.equal(status?.error, INPUT_REQUIRED_MESSAGE);
    assert.equal(
      status?.answer,
      'which repository?',
      'the question is the only way the parent learns what was asked'
    );
  });
});

for (const [state, pattern] of [
  ['canceled', /canceled the task/],
  ['rejected', /rejected the task/],
  ['failed', /failed the task/],
] as const) {
  test(`${state}: the sibling fails and says which way`, async () => {
    await withSpool(async spool => {
      const handle = sibling(spool, settling(state, 'because reasons'));
      assert.equal(await handle.exited, 1);
      const status = readStatus(spool, 'sib-001');
      assert.equal(status?.status, 'failed');
      assert.match(status?.error ?? '', pattern);
      assert.equal(status?.answer, 'because reasons');
    });
  });
}

test('a sibling reports running before it waits, so the parent sees it start', async () => {
  await withSpool(async spool => {
    let sawRunning: string | undefined;
    const client: RemoteCallClient = {
      sendMessage: (async () => {
        sawRunning = readStatus(spool, 'sib-001')?.status;
        return { kind: 'task', task: task('working') };
      }) as RemoteCallClient['sendMessage'],
      waitForTask: (async () =>
        task('completed', 'done')) as RemoteCallClient['waitForTask'],
      cancelTask: (async () => ({
        ok: true,
      })) as RemoteCallClient['cancelTask'],
    };
    await sibling(spool, client).exited;
    assert.equal(sawRunning, 'running');
  });
});

test('a prompt-less remote spawn is refused before anything is sent', async () => {
  await assert.rejects(
    () =>
      runRemoteAgent({
        agent,
        prompt: '   ',
        storeEnv: {},
        client: settling('completed') as never,
      }),
    /takes a prompt and answers it/
  );
});
