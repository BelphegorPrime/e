/**
 * The pure decision behind `spawn-brother.mjs --watch` (ADR-0015): given the
 * siblings at the start and the siblings now, which ones need the parent's
 * attention *newly*? A sibling that already needed it when the watch began is
 * reported at once (the agent may have missed it); one that reaches such a
 * state later ends the wait. Node built-ins only (bundled).
 */

import { needsAttention } from './taskState.js';
import type { SiblingRecord } from './types.js';

/**
 * The records the watch should report and stop on: those (of the one watched,
 * when `id` is given) whose task state needs attention and either did so
 * from the start or changed since. Empty means keep waiting.
 */
export function attentionSince(
  initial: readonly SiblingRecord[] | undefined,
  current: readonly SiblingRecord[],
  id?: string
): SiblingRecord[] {
  const before = new Map(
    (initial ?? []).map(record => [record.id, record.taskState])
  );
  return current.filter(record => {
    if (id !== undefined && record.id !== id) return false;
    if (!needsAttention(record.taskState)) return false;
    // First snapshot: report whatever already needs attention.
    if (initial === undefined) return true;
    return before.get(record.id) !== record.taskState;
  });
}
