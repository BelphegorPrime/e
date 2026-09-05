/**
 * **The branch-backed runs index** (ADR-0010, ADR-0003): resolves `/api/runs/*`
 * from git branches, because runs _are_ branches. This module is pure — it
 * turns `for-each-ref` output into a sorted, deduplicated run list and parses
 * branch short names back into run identities. Live timing and streaming log
 * views are deliberately absent; the namespace stays extensible by layering a
 * state store on top without changing identity (ADR-0003's considered-option
 * note).
 */

import type { RunRef } from './git/index';

/**
 * A parsed run branch: `e/<agent>/<slug>-N` (ADR-0003). The slug itself may
 * contain hyphens and digits, so the counter is taken from the trailing
 * `-<N>`.
 */
export interface RunIdentity {
  /** Durable branch short name, e.g. `e/claudeCode/fix-typos-2`. */
  branch: string;
  agent: string;
  slug: string;
  counter: number;
}

/**
 * Parses a branch short name into its run identity. Accepts local
 * (`e/...`) and remote-tracking (`origin/e/...`) short names; anything that
 * is not `[<remote>/]e/<agent>/<slug>-N` is not a run branch and yields
 * `undefined`.
 */
export function parseRunBranch(name: string): RunIdentity | undefined {
  const match = /^(?:([^/]+)\/)?e\/([^/]+)\/(.+)-(\d+)$/.exec(name);
  if (!match) return undefined;
  const remote = match[1];
  // A leading segment of `e` is the run's own namespace, not a remote name:
  // `feature/e/agent/slug-1` is not a run branch.
  if (remote === 'e') return undefined;
  return {
    // Strip the optional `<remote>/` prefix; `match[0]` is the whole name.
    branch: match[0]!.slice(remote ? remote.length + 1 : 0),
    agent: match[2]!,
    slug: match[3]!,
    counter: Number(match[4]),
  };
}

/** One run in the index: parsed identity plus its tip metadata. */
export interface RunIndexEntry extends RunIdentity {
  sha: string;
  /** ISO-8601 committer timestamp of the branch tip (oldest run sorts last). */
  committerDate: string;
  subject: string;
  /** True when a local `refs/heads/e/...` exists for this branch. */
  local: boolean;
  /** True when a `refs/remotes/<remote>/e/...` ref exists for this branch. */
  pushed: boolean;
}

/**
 * Builds the runs index from `for-each-ref` output: drops non-run branches,
 * merges local and remote-tracking refs of the same branch (the local tip
 * wins the metadata), and sorts newest run first. Remote-tracking refs that
 * have no local twin still appear — a run pushed to origin is a run.
 */
export function buildRunIndex(refs: RunRef[]): RunIndexEntry[] {
  const byBranch = new Map<string, RunIndexEntry>();
  for (const ref of refs) {
    const identity = parseRunBranch(ref.name);
    if (!identity) continue;
    const existing = byBranch.get(identity.branch);
    if (existing) {
      existing.pushed = true;
      if (ref.name === identity.branch) {
        existing.sha = ref.sha;
        existing.committerDate = ref.committerDate;
        existing.subject = ref.subject;
      }
      continue;
    }
    const local = ref.name === identity.branch;
    byBranch.set(identity.branch, {
      ...identity,
      sha: ref.sha,
      committerDate: ref.committerDate,
      subject: ref.subject,
      local,
      pushed: !local,
    });
  }
  const entries = [...byBranch.values()];
  // ISO-8601 strict timestamps compare lexicographically.
  entries.sort((a, b) => b.committerDate.localeCompare(a.committerDate));
  return entries;
}

/**
 * The ref short name to read `branch` from, preferring the local head over a
 * remote twin (so a local-only run is still readable). `undefined` when no
 * enumerated ref matches.
 */
export function resolveRunRef(
  refs: RunRef[],
  branch: string
): RunRef | undefined {
  return (
    refs.find(ref => ref.name === branch) ??
    refs.find(ref => parseRunBranch(ref.name)?.branch === branch)
  );
}
