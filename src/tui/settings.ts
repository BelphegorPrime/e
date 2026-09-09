import {
  ProcessTerminal,
  TuiMainScreen,
  Text,
  matchesKey,
  Key,
} from '@earendil-works/pi-tui';

export interface CheckboxRow {
  kind: 'checkbox';
  id: string;
  target: string;
  label: string;
  hint?: string;
  checked: boolean;
}

export interface CycleRow {
  kind: 'cycle';
  id: string;
  target: string;
  label: string;
  hint?: string;
  value: string;
  values: string[];
}

export interface HeaderRow {
  kind: 'header';
  label: string;
  hint?: string;
}

export type MenuRow = CheckboxRow | CycleRow | HeaderRow;
export type MenuResult = Record<string, string | string[]>;

export interface SettingsMenuOptions {
  title: string;
  instructions?: string;
}

export class MenuCancelledError extends Error {
  constructor() {
    super('Settings menu cancelled');
    this.name = 'MenuCancelledError';
  }
}

function isSelectable(row: MenuRow): row is CheckboxRow | CycleRow {
  return row.kind !== 'header';
}

function findFirstSelectable(rows: MenuRow[]): number {
  return rows.findIndex(isSelectable);
}

export async function runSettingsMenu(
  rowsFor: (partial: MenuResult) => MenuRow[],
  options: SettingsMenuOptions
): Promise<MenuResult> {
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);

  const partial: MenuResult = {};
  let cursor = 0;
  let settled = false;

  let resolvePromise!: (result: MenuResult) => void;
  let rejectPromise!: (error: Error) => void;

  const promise = new Promise<MenuResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  /*
   * Keep a stable component tree.
   *
   * TuiMainScreen uses differential rendering, so rebuilding the child
   * tree on every render can result in duplicated/stale terminal output.
   */
  const titleText = new Text(options.title);
  const instructionsText = options.instructions
    ? new Text(options.instructions)
    : undefined;

  let rowTexts: Text[] = [];

  tui.addChild(titleText);

  if (instructionsText) {
    tui.addChild(instructionsText);
  }

  const getRows = (): MenuRow[] => rowsFor(partial);

  const normalizeCursor = (rows: MenuRow[]) => {
    if (rows.length === 0) {
      cursor = 0;
      return;
    }

    if (cursor >= 0 && cursor < rows.length && isSelectable(rows[cursor])) {
      return;
    }

    const firstSelectable = findFirstSelectable(rows);

    if (firstSelectable >= 0) {
      cursor = firstSelectable;
    } else {
      cursor = 0;
    }
  };

  const ensureRowComponents = (rows: MenuRow[]) => {
    while (rowTexts.length < rows.length) {
      const text = new Text('');
      rowTexts.push(text);
      tui.addChild(text);
    }
  };

  const render = () => {
    const rows = getRows();

    normalizeCursor(rows);
    ensureRowComponents(rows);

    for (let i = 0; i < rowTexts.length; i++) {
      const text = rowTexts[i];

      if (i >= rows.length) {
        text.setText('');
        continue;
      }

      const row = rows[i];

      if (row.kind === 'header') {
        let label = row.label;

        if (row.hint) {
          label += ` (${row.hint})`;
        }

        text.setText(`─ ${label}`);
        continue;
      }

      const pointer = i === cursor ? '> ' : '  ';
      let label = row.label;

      if (row.kind === 'checkbox') {
        label = `${row.checked ? '[x]' : '[ ]'} ${label}`;
      }

      if (row.hint) {
        label += ` (${row.hint})`;
      }

      if (row.kind === 'cycle') {
        label += ` → ${row.value}`;
      }

      text.setText(`${pointer}${label}`);
    }

    tui.requestRender();
  };

  const moveCursor = (direction: 1 | -1) => {
    const rows = getRows();

    if (rows.length === 0) {
      return;
    }

    normalizeCursor(rows);

    let next = cursor;

    for (let i = 0; i < rows.length; i++) {
      next += direction;

      if (next < 0) {
        next = rows.length - 1;
      } else if (next >= rows.length) {
        next = 0;
      }

      if (isSelectable(rows[next])) {
        cursor = next;
        return;
      }
    }
  };

  const toggleCheckbox = (row: CheckboxRow) => {
    const current = Array.isArray(partial[row.target])
      ? [...(partial[row.target] as string[])]
      : [];

    const index = current.indexOf(row.id);

    if (index >= 0) {
      current.splice(index, 1);
    } else {
      current.push(row.id);
    }

    partial[row.target] = current;
  };

  const changeCycle = (row: CycleRow, direction: 1 | -1) => {
    if (row.values.length === 0) {
      return;
    }

    const currentIndex = row.values.indexOf(row.value);

    let nextIndex: number;

    if (currentIndex < 0) {
      nextIndex = 0;
    } else {
      nextIndex =
        (currentIndex + direction + row.values.length) % row.values.length;
    }

    partial[row.target] = row.values[nextIndex];
  };

  let removeInputListener = () => {};

  const finish = (result: MenuResult) => {
    if (settled) {
      return;
    }

    settled = true;
    removeInputListener();
    tui.stop();
    resolvePromise(result);
  };

  const cancel = (error: Error) => {
    if (settled) {
      return;
    }

    settled = true;
    removeInputListener();
    tui.stop();
    rejectPromise(error);
  };

  removeInputListener = tui.addInputListener(data => {
    if (settled) {
      return { consume: true };
    }

    if (matchesKey(data, 'q') || matchesKey(data, Key.ctrl('c'))) {
      cancel(new MenuCancelledError());
      return { consume: true };
    }

    if (matchesKey(data, Key.up)) {
      moveCursor(-1);
      render();
      return { consume: true };
    }

    if (matchesKey(data, Key.down)) {
      moveCursor(1);
      render();
      return { consume: true };
    }

    const rows = getRows();

    normalizeCursor(rows);

    const row = rows[cursor];

    if (!row || row.kind === 'header') {
      return { consume: true };
    }

    if (matchesKey(data, Key.left)) {
      if (row.kind === 'cycle') {
        changeCycle(row, -1);
        render();
      }

      return { consume: true };
    }

    if (matchesKey(data, Key.right)) {
      if (row.kind === 'cycle') {
        changeCycle(row, 1);
        render();
      }

      return { consume: true };
    }

    if (matchesKey(data, 'space')) {
      if (row.kind === 'checkbox') {
        toggleCheckbox(row);
        render();
      }

      return { consume: true };
    }

    if (matchesKey(data, Key.enter)) {
      finish(partial);
      return { consume: true };
    }

    return { consume: true };
  });

  tui.start();
  render();

  return promise;
}

export function isTuiAvailable(): boolean {
  return true;
}
