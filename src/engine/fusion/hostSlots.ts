/**
 * **The host-wide candidate bound** (ADR-0019 section 9): how many fusion
 * candidates may be alive at once across every `e fuse` on this host, counted
 * where every coordinator reads it - lease files under the worktrees dir -
 * never in one process's memory.
 *
 * A bound of N is N numbered files, `slot-0.json` to `slot-<N-1>.json`. A
 * lease is one of them, written temp + **link**: `link` fails when the name
 * exists, so of two coordinators reaching for one slot exactly one gets it,
 * and a reader never sees half a lease. No lock and no counter file: the
 * count is which names exist.
 *
 * - **Each coordinator stops at its own bound.** One that allows 1 only ever
 *   tries `slot-0`, so two Stores with different bounds never hold more than
 *   the larger between them.
 * - **A lease names two processes**: the coordinator, and once launched the
 *   candidate's `e spawn`, which runs in a process group of its own and so
 *   outlives a coordinator killed outright. The slot is in use while either
 *   is alive.
 * - **A dead lease is reclaimed**: one whose processes are both gone, or that
 *   cannot be read, is moved aside (`rename`, which only one reclaimer wins)
 *   and the slot taken again, so a coordinator killed outright costs the host
 *   nothing past its candidates' own end.
 * - **A release removes only its own lease**, checked by a token, so a lease
 *   that was reclaimed and handed on is never released by its first owner.
 *
 * Two limits, accepted rather than locked against: three coordinators racing
 * for one dead slot can, in a window of a few system calls, admit one
 * candidate too many until either ends; and a pid the OS reuses for an
 * unrelated process keeps a dead lease's slot held until that process ends.
 * Waiting is polling, not a queue: under contention a slot goes to whichever
 * coordinator asks first.
 */

import fs from 'node:fs';
import path from 'node:path';
import { monotonicFactory } from 'ulid';
import { readJson } from '../../sidecars/broker/contract/spool.js';
import { privateDir } from '../../shared/utils/privateFs.js';
import { processAlive } from './record.js';

/** Under the worktrees dir, beside the fusions' spools: `.fusion/.slots`. */
const SLOTS_DIR = path.join('.fusion', '.slots');

const newToken = monotonicFactory();

/** Who holds a lease: the fusion and the candidate attempt it was taken for. */
export interface HostSlotOwner {
  fusion: string;
  candidate: string;
}

/** One held slot; releasing it twice is harmless. */
export interface HostSlotLease {
  /** Names the candidate's process: the slot stays in use while it runs, whatever becomes of the coordinator. */
  attach(childPid: number): void;
  release(): void;
}

/** The host-wide bound as the fan-out sees it: a slot, or none free right now. */
export interface HostSlots {
  /** The bound, for the progress line that says why a candidate waits. */
  readonly limit: number;
  tryAcquire(owner: HostSlotOwner): HostSlotLease | undefined;
}

/** What a lease file holds. */
interface LeaseFile extends HostSlotOwner {
  /** The coordinator's pid. */
  pid: number;
  /** The candidate's `e spawn`, once launched; the lease is stale when neither is alive. */
  childPid?: number;
  /** This lease and no other: a release checks it. */
  token: string;
  acquiredAt: string;
}

/** The host's slot directory under `worktreesDir`. */
export function hostSlotsDir(worktreesDir: string): string {
  return path.join(worktreesDir, SLOTS_DIR);
}

/**
 * The host-wide bound of `limit` candidates, in `dir`. `pid` and `isAlive`
 * are this coordinator's and the liveness probe, injected by tests.
 */
export function fileHostSlots(
  dir: string,
  limit: number,
  opts: { pid?: number; isAlive?: (pid: number) => boolean } = {}
): HostSlots {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? processAlive;
  return {
    limit,
    tryAcquire(owner) {
      privateDir(dir);
      for (let i = 0; i < limit; i++) {
        const file = path.join(dir, `slot-${i}.json`);
        const lease: LeaseFile = {
          ...owner,
          pid,
          token: newToken(),
          acquiredAt: new Date().toISOString(),
        };
        if (create(file, lease)) return held(file, lease.token);
        if (reclaimIfStale(file, isAlive) && create(file, lease)) {
          return held(file, lease.token);
        }
      }
      return undefined;
    },
  };
}

/** Writes `lease` at `file` unless the name exists: temp + link. */
function create(file: string, lease: LeaseFile): boolean {
  const tmp = `${file}.${lease.token}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lease) + '\n', { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Frees the slot at `file` when its holder is gone, and says whether it is
 * free. Moved aside first, so of two reclaimers only one removes it; one that
 * finds it moved a live lease after all - a third coordinator took the slot
 * in between - puts it back.
 */
function reclaimIfStale(
  file: string,
  isAlive: (pid: number) => boolean
): boolean {
  if (!fs.existsSync(file)) return true;
  const seen = readJson<LeaseFile>(file);
  if (seen && typeof seen.pid === 'number' && inUse(seen, isAlive)) {
    return false;
  }
  const aside = `${file}.${newToken()}.stale`;
  try {
    fs.renameSync(file, aside);
  } catch (err) {
    // Another reclaimer was first, or its holder released it: free either way.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
  const moved = readJson<LeaseFile>(aside);
  const sameLease =
    seen === undefined ? moved === undefined : moved?.token === seen.token;
  try {
    if (!sameLease) {
      try {
        fs.linkSync(aside, file);
      } catch {
        // The slot was taken again meanwhile; the moved lease's owner will
        // find it gone, and its release is a no-op.
      }
      return false;
    }
    return true;
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

/** Whether a lease's coordinator or its candidate still runs. */
function inUse(lease: LeaseFile, isAlive: (pid: number) => boolean): boolean {
  if (isAlive(lease.pid)) return true;
  return typeof lease.childPid === 'number' && isAlive(lease.childPid);
}

/** The lease at `file`, changed and released only while it is still `token`'s. */
function held(file: string, token: string): HostSlotLease {
  let released = false;
  return {
    attach(childPid) {
      const lease = readJson<LeaseFile>(file);
      if (released || lease?.token !== token) return;
      // temp + rename: a reader sees the old lease or the new one, never half.
      const tmp = `${file}.${token}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...lease, childPid }) + '\n', {
        mode: 0o600,
      });
      fs.renameSync(tmp, file);
    },
    release() {
      if (released) return;
      released = true;
      if (readJson<LeaseFile>(file)?.token === token) {
        fs.rmSync(file, { force: true });
      }
    },
  };
}
