import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type CycleRow, type MenuRow, type MenuResult } from './settings.js';
import Readline from 'node:readline';

/** Result of dispatching one keypress in {@link dispatchKeyPress}. */
export type KeyOutcome =
  | { kind: 'cancel' }
  | { kind: 'finish' }
  | { kind: 'move'; cursor: number }
  | { kind: 'render' }
  | { kind: 'none' };

/**
 * Pure key-dispatch for the settings menu. Mutates `partial` (and cycle-row
 * `value`s) in place exactly like the interactive loop; the caller re-renders,
 * moves or finishes based on the outcome. Extracted so the Enter/Space split
 * and the movement rules are unit-testable without a TTY.
 */
export function dispatchKeyPress(
  key: Readline.Key,
  rows: MenuRow[],
  partial: MenuResult,
  cursor: number
): KeyOutcome {
  if ((key.ctrl && key.name === 'c') || key.name === 'q') {
    return { kind: 'cancel' };
  }
  if (key.name === 'up' || key.name === 'k') {
    let c = cursor;
    do c = (c - 1 + rows.length) % rows.length;
    while (rows[c]?.kind === 'header');
    return { kind: 'move', cursor: c };
  }
  if (key.name === 'down' || key.name === 'j') {
    let c = cursor;
    do c = (c + 1) % rows.length;
    while (rows[c]?.kind === 'header');
    return { kind: 'move', cursor: c };
  }
  if (key.name === 'space') {
    const row = rows[cursor];
    if (row?.kind === 'checkbox') {
      const list = [...((partial[row.target] as string[] | undefined) ?? [])];
      if (row.checked) {
        partial[row.target] = list.filter(id => id !== row.id);
      } else {
        partial[row.target] = [...list, row.id];
      }
      return { kind: 'render' };
    }
    if (row?.kind === 'cycle') {
      const idx = row.values.indexOf(row.value);
      row.value = row.values[(idx + 1) % row.values.length]!;
      partial[row.target] = row.value;
      return { kind: 'render' };
    }
    return { kind: 'render' };
  }
  if (key.name === 'return' || key.name === 'enter') {
    return { kind: 'finish' };
  }
  return { kind: 'none' };
}

const rows: MenuRow[] = [
  {
    kind: 'checkbox',
    id: 'llamacpp',
    target: 'runtimes',
    label: 'llama.cpp',
    checked: false,
  },
  {
    kind: 'checkbox',
    id: 'ollama',
    target: 'runtimes',
    label: 'Ollama',
    checked: false,
  },
  { kind: 'header', label: 'Harness' },
  {
    kind: 'cycle',
    id: 'harness',
    target: 'harness',
    label: 'Harness',
    value: 'pi',
    values: ['pi', 'codex'],
  },
  {
    kind: 'cycle',
    id: 'platform',
    target: 'platform',
    label: 'Git platform',
    value: 'github',
    values: ['github', 'gitlab'],
  },
];

const cycle = (id: string, rowsIn: MenuRow[]): CycleRow =>
  rowsIn.find(r => r.kind === 'cycle' && r.id === id) as CycleRow;

test('dispatchKeyPress: Enter finishes without toggling the focused row', () => {
  const partial: MenuResult = {};
  const outcome = dispatchKeyPress({ name: 'return' }, rows, partial, 0);
  assert.deepEqual(outcome, { kind: 'finish' });
  assert.deepEqual(partial, {}, 'Enter must not mutate the partial answer');
});

test('dispatchKeyPress: enter/return are both finish keys', () => {
  assert.equal(dispatchKeyPress({ name: 'enter' }, rows, {}, 0).kind, 'finish');
  assert.equal(
    dispatchKeyPress({ name: 'return' }, rows, {}, 0).kind,
    'finish'
  );
});

test('dispatchKeyPress: Space toggles a checkbox on, state lives in the partial answer', () => {
  const partial: MenuResult = {};
  const outcome = dispatchKeyPress({ name: 'space' }, rows, partial, 0);
  assert.equal(outcome.kind, 'render');
  assert.deepEqual(partial.runtimes, ['llamacpp']);
});

test('dispatchKeyPress: Space toggles a checkbox off again', () => {
  // Mirror the TUI: rows are re-derived from the partial answer, so a
  // checked-in-partial row arrives with checked: true.
  const partial: MenuResult = { runtimes: ['llamacpp'] };
  const derived: MenuRow[] = rows.map(r =>
    r.kind === 'checkbox' && r.id === 'llamacpp' ? { ...r, checked: true } : r
  );
  dispatchKeyPress({ name: 'space' }, derived, partial, 0);
  assert.deepEqual(partial.runtimes, []);
});

test('dispatchKeyPress: Space cycles a single-choice row and back', () => {
  const partial: MenuResult = {};
  dispatchKeyPress({ name: 'space' }, rows, partial, 3);
  assert.equal(partial.harness, 'codex');
  assert.equal(cycle('harness', rows).value, 'codex');
  dispatchKeyPress({ name: 'space' }, rows, partial, 3);
  assert.equal(partial.harness, 'pi');
  assert.equal(cycle('harness', rows).value, 'pi');
});

test('dispatchKeyPress: up/down skip header rows', () => {
  const down = dispatchKeyPress({ name: 'down' }, rows, {}, 2);
  assert.deepEqual(down, { kind: 'move', cursor: 3 });
  const up = dispatchKeyPress({ name: 'up' }, rows, {}, 3);
  assert.deepEqual(up, { kind: 'move', cursor: 1 });
});

test('dispatchKeyPress: movement wraps around the row list', () => {
  const up = dispatchKeyPress({ name: 'up' }, rows, {}, 0);
  assert.equal(up.kind, 'move');
  assert.equal((up as { cursor: number }).cursor, rows.length - 1);
});

test('dispatchKeyPress: q and Ctrl-C cancel', () => {
  assert.equal(dispatchKeyPress({ name: 'q' }, rows, {}, 0).kind, 'cancel');
  assert.equal(
    dispatchKeyPress({ name: 'c', ctrl: true }, rows, {}, 0).kind,
    'cancel'
  );
});

test('dispatchKeyPress: Space on a cycle row updates the collected result', () => {
  const partial: MenuResult = {};
  dispatchKeyPress({ name: 'space' }, rows, partial, 4);
  assert.equal(partial.platform, 'gitlab');
  const finish = dispatchKeyPress({ name: 'return' }, rows, partial, 4);
  assert.equal(finish.kind, 'finish');
  assert.equal(partial.platform, 'gitlab');
});

test('dispatchKeyPress: unknown keys do nothing', () => {
  const partial: MenuResult = {};
  const outcome = dispatchKeyPress({ name: 'x' }, rows, partial, 0);
  assert.deepEqual(outcome, { kind: 'none' });
  assert.deepEqual(partial, {});
});
