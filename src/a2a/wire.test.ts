import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  A2A_ERROR_CODES,
  A2A_METHODS,
  AGENT_CARD_PATH,
  canonicalMethod,
  dataPart,
  fromWireState,
  partsText,
  taskFromResult,
  textPart,
  toWireState,
} from './wire.js';
import {
  JsonRpcError,
  parseJsonRpcRequest,
  rpcError,
  rpcErrorFrom,
  rpcResult,
} from './jsonRpc.js';

test('toWireState / fromWireState: 1.0 spellings round-trip; 0.x spellings are read', () => {
  for (const state of [
    'submitted',
    'working',
    'input-required',
    'completed',
    'canceled',
    'failed',
    'rejected',
  ] as const) {
    assert.equal(fromWireState(toWireState(state)), state);
  }
  assert.equal(toWireState('input-required'), 'TASK_STATE_INPUT_REQUIRED');
  assert.equal(fromWireState('working'), 'working');
  assert.equal(fromWireState('input-required'), 'input-required');
  assert.equal(fromWireState('cancelled'), 'canceled');
  assert.equal(fromWireState('TASK_STATE_AUTH_REQUIRED'), 'working');
  assert.equal(fromWireState('TASK_STATE_UNSPECIFIED'), undefined);
  assert.equal(fromWireState('unknown'), undefined);
  assert.equal(fromWireState(42), undefined);
  assert.equal(fromWireState('something-new'), 'working');
});

test('parts: text parts join with blank lines, other parts are ignored; the writers emit 1.0 shapes', () => {
  assert.equal(
    partsText([{ text: 'a' }, { data: { x: 1 } }, { text: 'b' }, { url: 'u' }]),
    'a\n\nb'
  );
  assert.equal(partsText(undefined), '');
  assert.deepEqual(textPart('hi'), { text: 'hi' });
  assert.deepEqual(dataPart({ x: 1 }), {
    data: { x: 1 },
    mediaType: 'application/json',
  });
});

test('taskFromResult: a 1.0 {task} wrapper or a bare 0.x task; anything else is undefined', () => {
  const task = {
    id: 't1',
    contextId: 'c1',
    status: { state: 'TASK_STATE_WORKING' },
  };
  assert.deepEqual(taskFromResult({ task }), task);
  assert.deepEqual(taskFromResult({ ...task, kind: 'task' }), {
    ...task,
    kind: 'task',
  });
  assert.equal(taskFromResult({ message: { parts: [] } }), undefined);
  assert.equal(taskFromResult({ id: 't1' }), undefined);
  assert.equal(taskFromResult(null), undefined);
  assert.equal(taskFromResult('x'), undefined);
});

test("the well-known card path and the A2A error codes are the spec's", () => {
  assert.equal(AGENT_CARD_PATH, '/.well-known/agent-card.json');
  assert.equal(A2A_ERROR_CODES.taskNotFound, -32001);
  assert.equal(A2A_ERROR_CODES.taskNotCancelable, -32002);
  assert.equal(A2A_ERROR_CODES.pushNotificationNotSupported, -32003);
  assert.equal(A2A_ERROR_CODES.versionNotSupported, -32009);
});

test('parseJsonRpcRequest: a valid request; parse, envelope and params errors as responses', () => {
  const ok = parseJsonRpcRequest(
    '{"jsonrpc":"2.0","id":7,"method":"tasks/get","params":{"id":"t"}}'
  );
  assert.deepEqual(ok, {
    ok: true,
    request: {
      jsonrpc: '2.0',
      id: 7,
      method: 'tasks/get',
      params: { id: 't' },
    },
  });
  const noParams = parseJsonRpcRequest(
    '{"jsonrpc":"2.0","id":"a","method":"tasks/list"}'
  );
  assert.ok(noParams.ok);
  assert.equal('params' in noParams.request, false);

  const bad = (raw: string) => {
    const parsed = parseJsonRpcRequest(raw);
    assert.equal(parsed.ok, false);
    return parsed.ok ? undefined : parsed.response;
  };
  assert.equal(bad('nope')?.error?.code, -32700);
  assert.equal(bad('[]')?.error?.code, -32600);
  assert.equal(bad('{"id":1,"method":"m"}')?.error?.code, -32600);
  assert.equal(bad('{"jsonrpc":"2.0","id":1}')?.error?.code, -32600);
  assert.equal(
    bad('{"jsonrpc":"2.0","id":1,"method":"m","params":3}')?.error?.code,
    -32600
  );
  // The id is echoed when it can be read, null otherwise.
  assert.equal(bad('{"jsonrpc":"1.0","id":"x","method":"m"}')?.id, 'x');
  assert.equal(bad('{"jsonrpc":"1.0","id":{},"method":"m"}')?.id, null);
});

test('rpcResult / rpcError / rpcErrorFrom: envelopes; a JsonRpcError keeps its code and data, anything else is -32603', () => {
  assert.deepEqual(rpcResult(1, { a: 1 }), {
    jsonrpc: '2.0',
    id: 1,
    result: { a: 1 },
  });
  assert.deepEqual(rpcError(1, -32601, 'nope'), {
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32601, message: 'nope' },
  });
  assert.deepEqual(
    rpcErrorFrom('x', new JsonRpcError(-32001, 'gone', { id: 't' })),
    {
      jsonrpc: '2.0',
      id: 'x',
      error: { code: -32001, message: 'gone', data: { id: 't' } },
    }
  );
  assert.deepEqual(rpcErrorFrom(null, new Error('boom')), {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32603, message: 'boom' },
  });
});

test('the 1.0 RPC method names, with the 0.x slash names as aliases', () => {
  assert.equal(A2A_METHODS.sendMessage, 'SendMessage');
  assert.equal(A2A_METHODS.streamMessage, 'SendStreamingMessage');
  assert.equal(canonicalMethod('message/send'), 'SendMessage');
  assert.equal(canonicalMethod('tasks/resubscribe'), 'SubscribeToTask');
  assert.equal(
    canonicalMethod('tasks/pushNotificationConfig/set'),
    'CreateTaskPushNotificationConfig'
  );
  assert.equal(canonicalMethod('GetTask'), 'GetTask');
  assert.equal(canonicalMethod('nope'), 'nope');
});
