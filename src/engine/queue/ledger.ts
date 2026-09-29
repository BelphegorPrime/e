/**
 * **Every `e spawn` in the ledger** (ADR-0016 section 6). The ledger describes
 * what is running, so a run writes itself into it whoever started it:
 *
 * - started by `e serve`'s queue, it patches the entry `serve` claimed for it
 *   (`E_LEDGER_FILE`), whose slot `serve` holds;
 * - started by a human, it writes an entry of its own, `man-<ulid>`, that
 *   **takes no slot** - slots gate only what autonomy may start, and the human
 *   who typed it has already decided.
 *
 * Best-effort, always: a ledger that cannot be written never blocks or fails a
 * run. It only costs the run its line in `GET /api/runs`.
 */

import { env } from '../../shared/utils/env.js';
import { log } from '../../shared/utils/log.js';
import { errorMessage } from '../../shared/utils/errors.js';
import {
  newRequestId,
  patchLedgerFile,
  readLedgerFile,
  runsDirs,
  writeLedgerEntry,
  type LedgerEntry,
} from './runsSpool.js';
import type { RunBase } from '../runs/runSpawn.js';

/** A run's handle on its ledger entry. */
export interface RunLedger {
  /** Merges `patch` into the entry; never throws. */
  patch(patch: Partial<LedgerEntry>): void;
}

/** A ledger nobody reads: a spawn with no Store, or a test. */
export const NO_LEDGER: RunLedger = { patch: () => {} };

/**
 * Opens this run's ledger entry: the claimed one named by `E_LEDGER_FILE`, or
 * a new manual entry in the Store at `storeDir` (`.e/`). No Store, no entry.
 */
export function openRunLedger(opts: {
  storeDir: string | undefined;
  agent: string;
  now?: () => Date;
}): RunLedger {
  const now = opts.now ?? (() => new Date());
  let file = env.ledgerFile;
  if (file === undefined) {
    if (opts.storeDir === undefined) return NO_LEDGER;
    try {
      file = writeLedgerEntry(runsDirs(opts.storeDir), {
        id: newRequestId('man'),
        state: 'claimed',
        slot: false,
        agent: opts.agent,
        run: null,
        claimedAt: now().toISOString(),
      });
    } catch (err) {
      log.debug(`No ledger entry for this run: ${errorMessage(err)}`);
      return NO_LEDGER;
    }
  }
  const target = file;
  return {
    patch(patch) {
      try {
        patchLedgerFile(target, patch);
      } catch (err) {
        log.debug(
          `Could not update the ledger entry ${target}: ${errorMessage(err)}`
        );
      }
    },
  };
}

/**
 * The base `serve` resolved when it claimed this run (ADR-0016 section 7:
 * the base rule is applied before a child exists): what a queued run's
 * `e spawn` cuts from. Undefined for any other spawn, and for a claim made
 * without the rule (no base recorded). A base recorded but not whole throws:
 * falling back to the checkout would bypass the rule, so the run fails before
 * it has a branch, and `serve` makes it a dead request.
 */
export function claimedBase(
  file: string | undefined = env.ledgerFile
): RunBase | undefined {
  if (file === undefined) return undefined;
  const base = readLedgerFile(file)?.base as Partial<RunBase> | undefined;
  if (base === undefined) return undefined;
  if (
    typeof base.ref !== 'string' ||
    typeof base.sha !== 'string' ||
    typeof base.branch !== 'string'
  ) {
    throw new Error(
      `The ledger entry ${file} records a base that is not whole; refusing to cut from anywhere else`
    );
  }
  return { ref: base.ref, sha: base.sha, branch: base.branch };
}
