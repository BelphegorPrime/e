/**
 * **Where a Store's `serve` listens**: `.e/runs/serve.json`, written by every
 * `serve` - foreground or detached - once it is up, and removed when it
 * closes. `serve` owns `.e/runs/`, and the file is how `e trigger list` finds
 * the one process that remembers when each trigger last fired (ADR-0016
 * section 8), including the foreground `serve` a systemd unit supervises.
 *
 * Not the detached state file: that one drives `e serve --detached` reuse and
 * `e serve stop`, which must never find, or stop, a foreground server.
 */

import fs from 'node:fs';
import path from 'node:path';
import { asServeState, type ServeState } from './detachedServe.js';

/** The file, under the Store whose `.e/` is `storeDir`. */
export function storeServeFile(storeDir: string): string {
  return path.join(storeDir, 'runs', 'serve.json');
}

/** Records this process's address, atomically. */
export function writeStoreServe(storeDir: string, state: ServeState): void {
  const file = storeServeFile(storeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  fs.renameSync(tmp, file);
}

/** The recorded address, or undefined when there is none or it is unreadable. */
export function readStoreServe(storeDir: string): ServeState | undefined {
  try {
    return asServeState(
      JSON.parse(fs.readFileSync(storeServeFile(storeDir), 'utf8')) as unknown
    );
  } catch {
    return undefined;
  }
}

/** Removes the record, but only this process's: a newer `serve` may own it now. */
export function removeStoreServe(storeDir: string, pid: number): void {
  if (readStoreServe(storeDir)?.pid !== pid) return;
  fs.rmSync(storeServeFile(storeDir), { force: true });
}
