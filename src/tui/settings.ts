import {
  ProcessTerminal,
  TuiMainScreen,
  Text,
  matchesKey,
  Key,
} from '@earendil-works/pi-tui';

// --- Interfaces ---
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
export class MenuCancelledError extends Error {}

// --- Core TUI ---
export async function runSettingsMenu(
  rowsFor: (partial: MenuResult) => MenuRow[],
  options: SettingsMenuOptions
): Promise<MenuResult> {
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
  const partial: MenuResult = {};
  const cursor = 0;

  const render = () => {
    tui.clear();
    tui.addChild(new Text(options.title));
    if (options.instructions) tui.addChild(new Text(options.instructions));

    const rows = rowsFor(partial);
    rows.forEach((row, i) => {
      const pointer = i === cursor ? '> ' : '  ';
      let label = row.label;
      if (row.kind === 'checkbox')
        label = `${row.checked ? '[x]' : '[ ]'} ${label}`;
      if (row.hint) label += ` (${row.hint})`;
      if (row.kind === 'cycle') label += ` → ${row.value}`;
      tui.addChild(
        new Text(row.kind === 'header' ? `─ ${label}` : `${pointer}${label}`)
      );
    });
    tui.requestRender();
  };

  tui.addInputListener(data => {
    if (matchesKey(data, 'q') || matchesKey(data, Key.ctrl('c'))) {
      tui.stop();
      return { consume: true }; // Should reject promise
    }
    // Handle movement/selection (reusing logic or simplified for now)
    render();
    return { consume: true };
  });

  render();
  tui.start();
  // ... Promise logic ...
  return partial;
}

export function isTuiAvailable(): boolean {
  return true;
}
