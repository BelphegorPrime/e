/**
 * The A2A task state of a sibling record (ADR-0015). The run states
 * (`requested` ... `done`) describe the sibling *process*; the merge-back
 * describes what happened to its work. The Agent2Agent protocol's task
 * lifecycle is the one vocabulary that covers both, so it is derived here,
 * once, for the broker (`GET /status`), the host (reports, the `--watch`
 * script) and the A2A facade on `e serve`. Node built-ins only: bundled.
 */

import type {
  MergeBack,
  SiblingState,
  SiblingStatusPatch,
  TaskState,
} from './types.js';

/** What the mapping needs of a record: the run state, how it exited, its merge-back. */
export type TaskStateInput = Pick<SiblingStatusPatch, 'exitCode' | 'merge'> & {
  status: SiblingState;
};

/** A2A: nothing more will happen to a task in one of these states. */
export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  'completed',
  'failed',
  'canceled',
  'rejected',
];

/** The run states nothing more will happen in (the host is done with the request). */
export const TERMINAL_SIBLING_STATES: readonly SiblingState[] = [
  'done',
  'failed',
  'canceled',
  'rejected',
];

/** The merge-back states that wait on the parent: A2A's `input-required`. */
const WAITING_ON_PARENT: readonly MergeBack['status'][] = ['conflict', 'held'];

/**
 * Maps a record to its A2A task state:
 *  - `requested` → `submitted`; `starting` / `running` → `working`;
 *  - `done` with a merge-back waiting on the parent → `input-required`;
 *  - `done` that exited non-zero → `failed` (the work was not captured);
 *  - `done` otherwise → `completed`; `failed` / `canceled` / `rejected` as is.
 */
export function taskStateOf(record: TaskStateInput): TaskState {
  switch (record.status) {
    case 'requested':
      return 'submitted';
    case 'starting':
    case 'running':
      return 'working';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    case 'rejected':
      return 'rejected';
    case 'done':
      if (record.merge && WAITING_ON_PARENT.includes(record.merge.status)) {
        return 'input-required';
      }
      if (record.exitCode !== undefined && record.exitCode !== 0) {
        return 'failed';
      }
      return 'completed';
  }
}

/** True when nothing more will happen to a task: completed, failed, canceled or rejected. */
export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

/** True when a task state asks something of its requester: terminal, or waiting for input. */
export function needsAttention(state: TaskState): boolean {
  return state === 'input-required' || isTerminalTaskState(state);
}

/** True when the host is done with a request: nothing to cancel any more. */
export function isTerminalSiblingState(state: SiblingState): boolean {
  return TERMINAL_SIBLING_STATES.includes(state);
}
