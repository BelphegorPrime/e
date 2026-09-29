/**
 * **Gate removals** (ADR-0016 section 11): how much of what the check
 * measures the run branch deleted. The loop rewards exactly one attack -
 * deleting or loosening the tests turns the verdict green honestly by exit
 * code - so the host counts, over `base..tip`, the lines removed under the
 * Store's `verify.guards`.
 *
 * Numbers, never a boolean: a boolean is what downstream code branches on,
 * and a heuristic that is branched on is a gate after all. Keyed on removals,
 * never on touches, since adding tests touches the same files. Measured once
 * per run over what the branch - and so the PR - holds: a test deleted in
 * one attempt and restored in the next has weakened nothing.
 *
 * For human eyes only - the run report and the PR - and never for an agent's:
 * a counted signal handed to the agent teaches it to launder the removal.
 * Accepted limit: this counts removed lines, not weakened semantics; a binary
 * file git does not count reads as no removal.
 */

import type { Git, NumstatEntry } from '../../ports/git/index.js';
import { DEFAULT_VERIFY_GUARDS } from '../../core/store/config.js';

/** Guarded files with lines removed, and those lines, over the run branch. */
export interface GateRemovals {
  files: number;
  lines: number;
}

/** Sums the removals of a numstat: a file counts once it lost a line. */
export function gateRemovalsOf(entries: NumstatEntry[]): GateRemovals {
  let files = 0;
  let lines = 0;
  for (const entry of entries) {
    if (!entry.removed) continue;
    files += 1;
    lines += entry.removed;
  }
  return { files, lines };
}

/**
 * Measures {@link GateRemovals} over `base..tip` under `guards`, the built-in
 * test paths when the Store declares none. `[]` guards nothing, and git is not
 * asked: an empty pathspec list would be every file.
 */
export function measureGateRemovals(
  git: Git,
  base: string,
  tip: string,
  guards: readonly string[] | undefined
): GateRemovals {
  const pathspecs = [...(guards ?? DEFAULT_VERIFY_GUARDS)];
  if (pathspecs.length === 0) return { files: 0, lines: 0 };
  return gateRemovalsOf(git.numstat(base, tip, pathspecs));
}

/** How the human reads it: `2 files, -47 lines`. */
export function describeGateRemovals(removals: GateRemovals): string {
  const files = removals.files === 1 ? 'file' : 'files';
  const lines = removals.lines === 1 ? 'line' : 'lines';
  return `${removals.files} ${files}, -${removals.lines} ${lines}`;
}
