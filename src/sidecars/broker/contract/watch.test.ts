import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attentionSince } from './watch.js';
import type { SiblingRecord, SiblingState, TaskState } from './types.js';

const RUN_STATE: Record<TaskState, SiblingState> = {
  submitted: 'requested',
  working: 'running',
  'input-required': 'done',
  completed: 'done',
  failed: 'failed',
  canceled: 'canceled',
  rejected: 'rejected',
};

function record(id: string, taskState: TaskState): SiblingRecord {
  return {
    id,
    agent: 'smart-claude',
    prompt: 'do the thing',
    requestedAt: '2026-09-12T10:00:00.000Z',
    status: RUN_STATE[taskState],
    taskState,
  };
}

const ids = (records: readonly SiblingRecord[]): string[] =>
  records.map(r => r.id);

test('attentionSince: the first snapshot reports whatever already needs attention', () => {
  const current = [
    record('sib-001', 'working'),
    record('sib-002', 'completed'),
    record('sib-003', 'input-required'),
    record('sib-004', 'submitted'),
    record('sib-005', 'failed'),
  ];
  assert.deepEqual(ids(attentionSince(undefined, current)), [
    'sib-002',
    'sib-003',
    'sib-005',
  ]);
});

test('attentionSince: the first snapshot is empty while every sibling is still running', () => {
  const current = [
    record('sib-001', 'working'),
    record('sib-002', 'submitted'),
  ];
  assert.deepEqual(attentionSince(undefined, current), []);
});

test('attentionSince: a sibling that already needed attention when the watch began is not reported again', () => {
  const initial = [
    record('sib-001', 'completed'),
    record('sib-002', 'working'),
  ];
  const current = [
    record('sib-001', 'completed'),
    record('sib-002', 'working'),
  ];
  assert.deepEqual(attentionSince(initial, current), []);
});

test('attentionSince: a sibling that reaches a needing-attention state ends the wait', () => {
  const initial = [record('sib-001', 'working'), record('sib-002', 'working')];
  const current = [record('sib-001', 'working'), record('sib-002', 'failed')];
  assert.deepEqual(ids(attentionSince(initial, current)), ['sib-002']);
});

test('attentionSince: a move between two needing-attention states is reported (input-required -> completed)', () => {
  const initial = [record('sib-001', 'input-required')];
  const current = [record('sib-001', 'completed')];
  assert.deepEqual(ids(attentionSince(initial, current)), ['sib-001']);
});

test('attentionSince: a state change that still does not need attention keeps the wait open', () => {
  const initial = [record('sib-001', 'submitted')];
  const current = [record('sib-001', 'working')];
  assert.deepEqual(attentionSince(initial, current), []);
});

test('attentionSince: a sibling requested after the watch began counts as changed', () => {
  const initial = [record('sib-001', 'working')];
  const current = [record('sib-001', 'working'), record('sib-002', 'rejected')];
  assert.deepEqual(ids(attentionSince(initial, current)), ['sib-002']);
});

test('attentionSince: an id narrows the watch to that sibling alone', () => {
  const initial = [record('sib-001', 'working'), record('sib-002', 'working')];
  const current = [record('sib-001', 'completed'), record('sib-002', 'failed')];
  assert.deepEqual(ids(attentionSince(initial, current, 'sib-002')), [
    'sib-002',
  ]);
  assert.deepEqual(attentionSince(initial, current, 'sib-001').length, 1);
  // An id nobody in the snapshot carries reports nothing rather than everything.
  assert.deepEqual(attentionSince(initial, current, 'sib-404'), []);
  assert.deepEqual(attentionSince(undefined, current, 'sib-404'), []);
});

test('attentionSince: an id whose sibling is still working reports nothing, even on the first snapshot', () => {
  const current = [
    record('sib-001', 'completed'),
    record('sib-002', 'working'),
  ];
  assert.deepEqual(attentionSince(undefined, current, 'sib-002'), []);
});

test('attentionSince: reports the current records, in snapshot order', () => {
  const done = record('sib-003', 'completed');
  const canceled = record('sib-001', 'canceled');
  const current = [done, record('sib-002', 'working'), canceled];
  const reported = attentionSince(undefined, current);
  assert.deepEqual(ids(reported), ['sib-003', 'sib-001']);
  // The caller prints these as JSON, so they must be the fresh records.
  assert.equal(reported[0], done);
  assert.equal(reported[1], canceled);
});
