import type { Trigger } from './index.js';
import { payloadReferences } from './prompt.js';

/**
 * The **one-shot** shape's pure rules (ADR-0016 section 13): `e spawn
 * --trigger <name> [--event <path>]`, one process, driven by whatever
 * surrounds it. The declaration is the hosted one, unchanged; what differs is
 * that no listener handed over a payload and no scheduler a tick, so this is
 * where "what is available without them" is decided.
 */

/** Where the full payload is mounted, read-only and outside the worktree. */
export const EVENT_MOUNT_PATH = '/run/e/event.json';

/**
 * The largest payload file accepted: the listener's cap, so one-shot never
 * mounts what the hosted shape would have refused.
 */
export const EVENT_PAYLOAD_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Throws, naming the field, when a trigger needs a payload it will not get.
 * Without `--event` only `{{trigger}}` and `{{tick}}` exist, and a prompt that
 * silently rendered an empty issue number would be a run on nothing.
 */
export function requirePayloadFree(trigger: Trigger): void {
  const fields: [string, string | undefined][] = [
    ['prompt', trigger.prompt],
    ['base', trigger.base],
  ];
  for (const [field, template] of fields) {
    const [path] = payloadReferences(template ?? '');
    if (path !== undefined) {
      throw new Error(
        `Trigger "${trigger.name}": "${field}" references {{${path}}}, a payload path, and no --event was given; without a payload only {{trigger}} and {{tick}} interpolate`
      );
    }
  }
}

/**
 * The `{{tick}}` value: minute-granular, UTC, compact - the cron dedup
 * value's spelling, so a one-shot tick and a hosted one read alike.
 */
export function tickStamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
}

/** Full ref prefixes that name the target repository itself. */
const TARGET_REF_PREFIXES = [
  'refs/heads/',
  'refs/tags/',
  'refs/remotes/origin/',
];

/**
 * A pull request's ref, however it was fetched: GitHub's own `refs/pull/*`,
 * `actions/checkout`'s `refs/remotes/pull/*`, or a mirror under a remote.
 */
export function isPullRef(ref: string): boolean {
  return /^refs\/(?:pull\/|remotes\/(?:[^/]+\/)?pull\/)/.test(ref);
}

/** Where a `base` may be looked up, or why it may not be looked up at all. */
export type BaseCandidates =
  { ok: true; candidates: string[] } | { ok: false; reason: string };

/**
 * **The base rule**: the resolved `base` must be a ref in the target
 * repository itself, which is what keeps unreviewed code out of the worktree.
 * A fork's head ref drops out by construction, a raw sha is not a ref, and
 * `refs/pull/*` is refused by name, before anything is looked up.
 *
 * A short name is tried as a local branch, then as origin's, then as a tag;
 * `origin/<x>` means origin's branch only. Candidates are tried in order by
 * the caller, which also checks {@link isPullRef} on what actually resolved.
 */
export function baseRefCandidates(name: string): BaseCandidates {
  if (name === '') return { ok: false, reason: 'base is empty' };
  // Never a flag, whatever reaches git's argv.
  if (name.startsWith('-')) {
    return { ok: false, reason: `base "${name}" is not a ref name` };
  }
  if (isPullRef(name)) {
    return {
      ok: false,
      reason: `base "${name}" is a pull request ref (refs/pull/*), which holds unreviewed code`,
    };
  }
  if (name.startsWith('refs/')) {
    if (TARGET_REF_PREFIXES.some(prefix => name.startsWith(prefix))) {
      return { ok: true, candidates: [name] };
    }
    return {
      ok: false,
      reason: `base "${name}" is not a branch or tag of the target repository (refs/heads/, refs/tags/ or refs/remotes/origin/)`,
    };
  }
  if (name.startsWith('origin/')) {
    return {
      ok: true,
      candidates: [`refs/remotes/origin/${name.slice('origin/'.length)}`],
    };
  }
  return {
    ok: true,
    candidates: [
      `refs/heads/${name}`,
      `refs/remotes/origin/${name}`,
      `refs/tags/${name}`,
    ],
  };
}

/** The short name a full target ref goes by: the branch a PR would target. */
export function branchOfRef(ref: string): string {
  for (const prefix of TARGET_REF_PREFIXES) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return ref;
}
