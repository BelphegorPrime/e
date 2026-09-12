import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TERMINAL_SIBLING_STATES,
  TERMINAL_TASK_STATES,
  isTerminalSiblingState,
  needsAttention,
  taskStateOf,
} from './taskState.js';

test('taskStateOf: the run states map onto the A2A lifecycle', () => {
  assert.equal(taskStateOf({ status: 'requested' }), 'submitted');
  assert.equal(taskStateOf({ status: 'starting' }), 'working');
  assert.equal(taskStateOf({ status: 'running' }), 'working');
  assert.equal(taskStateOf({ status: 'failed' }), 'failed');
  assert.equal(taskStateOf({ status: 'canceled' }), 'canceled');
  assert.equal(taskStateOf({ status: 'rejected' }), 'rejected');
});

test('taskStateOf: a done sibling is completed, failed when it exited non-zero, input-required while its merge-back waits on the parent', () => {
  assert.equal(taskStateOf({ status: 'done' }), 'completed');
  assert.equal(taskStateOf({ status: 'done', exitCode: 0 }), 'completed');
  assert.equal(
    taskStateOf({ status: 'done', exitCode: 0, merge: { status: 'merged' } }),
    'completed'
  );
  assert.equal(
    taskStateOf({
      status: 'done',
      exitCode: 0,
      merge: { status: 'skipped', reason: 'remote' },
    }),
    'completed'
  );
  assert.equal(taskStateOf({ status: 'done', exitCode: 2 }), 'failed');
  assert.equal(
    taskStateOf({
      status: 'done',
      exitCode: 0,
      merge: { status: 'conflict', files: ['a.ts'] },
    }),
    'input-required'
  );
  assert.equal(
    taskStateOf({
      status: 'done',
      exitCode: 0,
      merge: { status: 'held', files: [], reason: 'in flight' },
    }),
    'input-required'
  );
});

test('needsAttention: terminal states and input-required, nothing else', () => {
  for (const state of TERMINAL_TASK_STATES)
    assert.equal(needsAttention(state), true);
  assert.equal(needsAttention('input-required'), true);
  assert.equal(needsAttention('submitted'), false);
  assert.equal(needsAttention('working'), false);
});

test('isTerminalSiblingState: done, failed, canceled, rejected', () => {
  assert.deepEqual(TERMINAL_SIBLING_STATES, [
    'done',
    'failed',
    'canceled',
    'rejected',
  ]);
  assert.equal(isTerminalSiblingState('done'), true);
  assert.equal(isTerminalSiblingState('running'), false);
  assert.equal(isTerminalSiblingState('requested'), false);
});
