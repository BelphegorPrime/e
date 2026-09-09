import * as readline from 'node:readline';
import { setImmediate } from 'node:timers';

/**
 * A self-contained settings-menu TUI built on the raw-mode keypress pipeline
 * (no external dependencies, so it survives the `pkg` binary build). It is a
 * "mark what you want" picker: arrow keys move, Space toggles checkboxes and
 * cycles single choices, Enter finishes.
 *
 * The declarative core: rows are derived from the current partial answer on
 * every render (`rowsFor`), so the List can recompute dependent rows (e.g. the
 * model list under the currently selected runtimes) the moment a row changes.
 */

/** A focused checkbox row ("mark what you want"). */
export interface CheckboxRow {
  kind: 'checkbox';
  /** Stable identity, e.g. `runtime:llamacpp`. */
  id: string;
  /** Grouping; results collect into one slot per target. */
  target: string;
  label: string;
  hint?: string;
  checked: boolean;
}

/** A single-choice row; Space cycles through `values`. */
export interface CycleRow {
  kind: 'cycle';
  id: string;
  target: string;
  label: string;
  hint?: string;
  value: string;
  values: string[];
}

/** A non-focusable section separator. */
export interface HeaderRow {
  kind: 'header';
  label: string;
}

export type MenuRow = CheckboxRow | CycleRow | HeaderRow;

/** Collected answers: checkbox targets map to id arrays, cycle targets to a string. */
export type MenuResult = Record<string, string | string[]>;

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
  key: readline.Key,
  rows: MenuRow[],
  partial: MenuResult,
  cursor: number
): KeyOutcome {
  if ((key.ctrl && key.name === 'c') || key.name === 'q') {
    return { kind: 'cancel' };
  }
  if (key.name === 'up' || key.name === 'k') {
    let c = cursor;
    do c = (c - 1 + rows.length) % rows.length; while (rows[c]?.kind === 'header');
    return { kind: 'move', cursor: c };
  }
  if (key.name === 'down' || key.name === 'j') {
    let c = cursor;
    do c = (c + 1) % rows.length; while (rows[c]?.kind === 'header');
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

export interface SettingsMenuOptions {
  title: string;
  instructions?: string;
}

/**
 * True when stdin/stdout are TTYs and the process can enter raw mode — the
 * precondition for the interactive menu. Non-interactive runs fall back to the
 * readline prompts.
 */
export function isTuiAvailable(): boolean {
  return (
    typeof process.stdin.setRawMode === 'function' &&
    Boolean(process.stdin.isTTY) &&
    Boolean(process.stdout.isTTY)
  );
}

/**
 * Thrown by {@link runSettingsMenu} when the user quits with `q` or Ctrl-C.
 * Callers treat this as a clean abort — nothing was written, no stack dump.
 */
export class MenuCancelledError extends Error {
  constructor() {
    super('Settings menu cancelled.');
    this.name = 'MenuCancelledError';
  }
}

/**
 * Runs the settings menu on the alternate screen. `rowsFor` derives the rows
 * from the partial result on every render. Resolves to the final result when
 * the user presses Enter; rejects with {@link MenuCancelledError} on Ctrl-C / `q`.
 */
export function runSettingsMenu(
  rowsFor: (partial: MenuResult) => MenuRow[],
  options: SettingsMenuOptions
): Promise<MenuResult> {
  const input = process.stdin;
  const output = process.stdout;
  const partial: MenuResult = {};
  let cursor = 0;

  const collect = (rows: MenuRow[]): MenuResult => {
    const result: MenuResult = {};
    for (const row of rows) {
      if (row.kind === 'header') continue;
      if (row.kind === 'checkbox') {
        const list = new Set((result[row.target] as string[] | undefined) ?? []);
        if (row.checked) list.add(row.id);
        result[row.target] = [...list];
      } else {
        result[row.target] = row.value;
      }
    }
    return result;
  };

  const render = (): void => {
    const rows = rowsFor(partial);
    if (cursor >= rows.length) cursor = Math.max(0, rows.length - 1);
    while (rows[cursor]?.kind === 'header') cursor = Math.min(rows.length - 1, cursor + 1);
    output.write('\x1b[H\x1b[J');
    output.write(`\x1b[1m${options.title}\x1b[22m\n`);
    if (options.instructions) output.write(`\x1b[2m${options.instructions}\x1b[22m\n`);
    output.write('\n');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.kind === 'header') {
        output.write(`\x1b[36m─ ${row.label}\x1b[39m\n`);
        continue;
      }
      const pointer = i === cursor ? '\x1b[1m>\x1b[22m ' : '  ';
      let body: string;
      if (row.kind === 'checkbox') {
        body = `${row.checked ? '\x1b[32m[x]\x1b[39m' : '[ ]'} ${row.label}`;
      } else {
        body = `${row.label}`;
      }
      const hint = row.hint ? ` \x1b[2m(${row.hint})\x1b[22m` : '';
      const value =
        row.kind === 'cycle' ? ` \x1b[2m→ ${row.value}\x1b[22m` : '';
      const line = `${pointer}${body}${hint}${value}`;
      // Truncate to the terminal width; leave the last column free.
      output.write(`${line.slice(0, Math.max(1, output.columns - 1))}\n`);
    }
    output.write('\n\x1b[2mSpace toggle/cycle · Enter finish · ↑/↓ move · q/Ctrl-C quit\x1b[22m\n');
  };

  const cleanup = (): void => {
    input.removeListener('keypress', onKeypress);
    input.resume();
    output.write('\x1b[?1049l');
  };

  let resolve!: (r: MenuResult) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<MenuResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const onKeypress = (_: string, key: readline.Key): void => {
    const outcome = dispatchKeyPress(key, rowsFor(partial), partial, cursor);
    switch (outcome.kind) {
      case 'cancel':
        cleanup();
        reject(new MenuCancelledError());
        break;
      case 'finish':
        cleanup();
        resolve(collect(rowsFor(partial)));
        break;
      case 'move':
        cursor = outcome.cursor;
        render();
        break;
      case 'render':
        render();
        break;
      case 'none':
        break;
    }
  };

  input.pause();
  readline.emitKeypressEvents(input);
  input.setRawMode?.(true);
  output.write('\x1b[?1049h');
  render();
  setImmediate(() => {
    // Drop whatever Enter-echo the previous readline prompt left buffered.
    while (input.read() !== null) {
      // Drain buffered input.
    }
    input.on('keypress', onKeypress);
    input.resume();
  });

  return promise;
}