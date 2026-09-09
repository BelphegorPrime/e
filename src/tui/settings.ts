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

/** A single-choice row; Space/Enter cycles through `values`. */
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
    output.write('\n\x1b[2mSpace/Enter toggle or cycle · ↑/↓ move · q/Ctrl-C quit\x1b[22m\n');
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
    if ((key.ctrl && key.name === 'c') || key.name === 'q') {
      cleanup();
      reject(new MenuCancelledError());
      return;
    }
    const rows = rowsFor(partial);
    if (key.name === 'up' || key.name === 'k') {
      do cursor = (cursor - 1 + rows.length) % rows.length; while (rows[cursor]?.kind === 'header');
      render();
    } else if (key.name === 'down' || key.name === 'j') {
      do cursor = (cursor + 1) % rows.length; while (rows[cursor]?.kind === 'header');
      render();
    } else if (key.name === 'space' || key.name === 'return' || key.name === 'enter') {
      const row = rows[cursor];
      if (row?.kind === 'checkbox') {
        const list = [
          ...((partial[row.target] as string[] | undefined) ?? []),
        ];
        if (row.checked) {
          partial[row.target] = list.filter(id => id !== row.id);
        } else {
          partial[row.target] = [...list, row.id];
        }
        render();
      } else if (row?.kind === 'cycle') {
        const idx = row.values.indexOf(row.value);
        row.value = row.values[(idx + 1) % row.values.length]!;
        partial[row.target] = row.value;
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        // Enter on the empty space below the rows finishes.
        cleanup();
        resolve(collect(rows));
      }
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