import type { Trigger } from './index.js';
import { matchesEvent } from './match.js';
import { payloadReferences, renderTriggerPrompt } from './prompt.js';

/**
 * The **one-shot** shape's pure rules (ADR-0016 section 13): `e spawn
 * --trigger <name> [--event <path>]`, one process, driven by whatever
 * surrounds it. The declaration is the hosted one, unchanged; what differs is
 * that no listener handed over a payload and no scheduler a tick, so this is
 * where "what is available without them" is decided.
 *
 * Every decision lives here and does no I/O; the engine reads the
 * declarations, the refs and the payload and hands the results in
 * (ADR-0008's gather, then decide).
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

/**
 * Full ref prefixes that name the target repository itself: origin's
 * branches and the tags. A local branch is this machine's state, not the
 * repository's - `gh pr checkout` makes one out of a fork's head.
 */
const TARGET_REF_PREFIXES = ['refs/remotes/origin/', 'refs/tags/'];

/** A base the rule refused, or that does not exist: the run never starts. */
export function baseError(why: string): Error {
  return new Error(`Base error: ${why}`);
}

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
 * A fork's head ref drops out by construction, a raw sha is not a ref, a
 * local branch is not the repository's, and `refs/pull/*` is refused by name,
 * before anything is looked up.
 *
 * A short name is tried as origin's branch, then as a tag; `origin/<x>` means
 * origin's branch only. Candidates are tried in order by the caller, which
 * also checks {@link isPullRef} on what actually resolved.
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
  if (name.startsWith('refs/heads/')) {
    const branch = name.slice('refs/heads/'.length);
    return {
      ok: false,
      reason: `base "${name}" is a local branch, which is this machine's state rather than the target repository's; name origin's branch instead (origin/${branch})`,
    };
  }
  if (name.startsWith('refs/')) {
    if (TARGET_REF_PREFIXES.some(prefix => name.startsWith(prefix))) {
      return { ok: true, candidates: [name] };
    }
    return {
      ok: false,
      reason: `base "${name}" is not a branch or tag of the target repository (refs/remotes/origin/ or refs/tags/)`,
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
    candidates: [`refs/remotes/origin/${name}`, `refs/tags/${name}`],
  };
}

/** The short name a full target ref goes by: the branch a PR would target. */
export function branchOfRef(ref: string): string {
  for (const prefix of TARGET_REF_PREFIXES) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return ref;
}

/** What one-shot has of the event: the payload and its name, when it has them. */
export interface OneShotEvent {
  /** The parsed `--event` file, absent without one (and for a cron trigger). */
  payload?: unknown;
  /** The provider's event name (`--event-name`, `$GITHUB_EVENT_NAME`). */
  name?: string;
}

/**
 * The event as this trigger sees it, and what the human should know about
 * that. A cron trigger has no event: a payload is dropped, never mounted, and
 * its schedule is ignored, because the outer scheduler already fired it.
 */
export function oneShotEvent(
  trigger: Trigger,
  payload: unknown,
  name: string | undefined
): { event: OneShotEvent; warnings: string[] } {
  if (trigger.on.type !== 'cron') {
    return {
      event: {
        ...(payload !== undefined ? { payload } : {}),
        ...(name !== undefined ? { name } : {}),
      },
      warnings: [],
    };
  }
  const warnings: string[] = [];
  if (payload !== undefined) {
    warnings.push(
      `Trigger "${trigger.name}" is a cron trigger, which has no event: --event is ignored and nothing is mounted.`
    );
  }
  warnings.push(
    `Trigger "${trigger.name}" is a cron trigger: one-shot runs it now, and its expr and tz are ignored.`
  );
  return { event: {}, warnings };
}

/**
 * Why this declaration starts no run for this event - a skip, not an error -
 * or undefined when it runs. A skip is decided first, so a disabled trigger
 * stays quiet however it is declared. Throws on what is an error: a payload
 * the declaration needs and did not get, or a payload without its name.
 */
export function oneShotRefusal(
  trigger: Trigger,
  event: OneShotEvent
): string | undefined {
  if (!trigger.enabled) {
    return `Trigger "${trigger.name}" is disabled; no run started.`;
  }
  // Without a payload the pipeline's own filter is all there is, and the
  // declaration must need nothing from one.
  if (event.payload === undefined) {
    requirePayloadFree(trigger);
    return undefined;
  }
  if (trigger.on.type !== 'webhook') return undefined;
  if (event.name === undefined) {
    throw new Error(
      `Trigger "${trigger.name}" filters on the event, and --event was given without its name: pass --event-name <name>, or run where GITHUB_EVENT_NAME is set`
    );
  }
  if (!matchesEvent(trigger.on, { name: event.name, payload: event.payload })) {
    const action = trigger.on.action ? `.${trigger.on.action}` : '';
    return `Trigger "${trigger.name}" listens to ${trigger.on.event}${action}; this ${event.name} event does not match its on/match, so no run started.`;
  }
  return undefined;
}

/**
 * The declared `base`, rendered through the same whitelist as the prompt;
 * undefined when the trigger declares none. A value that fails its pattern
 * is a base error, never coerced.
 */
export function renderBaseName(
  trigger: Trigger,
  event: OneShotEvent,
  tick: string
): string | undefined {
  if (trigger.base === undefined) return undefined;
  const rendered = renderTriggerPrompt(trigger.base, {
    payload: event.payload,
    trigger: trigger.name,
    tick,
  });
  if (!rendered.ok) throw baseError(`"base": ${rendered.reason}`);
  return rendered.text;
}

/**
 * The declaration committed at base must declare the base it was read from:
 * otherwise the default branch's file and base's file would name two
 * different bases, and one trigger would mean two things.
 */
export function requireSameBase(
  atBase: Trigger,
  anchor: Trigger,
  baseRef: string,
  anchorRef: string
): void {
  if (atBase.base === anchor.base) return;
  throw baseError(
    `the declaration at ${baseRef} declares base ${JSON.stringify(atBase.base ?? null)}, and the one at ${anchorRef} declares ${JSON.stringify(anchor.base)}; they must agree`
  );
}

/** The run's prompt; a template the whitelist refuses names the field. */
export function renderOneShotPrompt(
  trigger: Trigger,
  event: OneShotEvent,
  tick: string
): string {
  const prompt = renderTriggerPrompt(trigger.prompt, {
    payload: event.payload,
    trigger: trigger.name,
    tick,
  });
  if (!prompt.ok) {
    throw new Error(`Trigger "${trigger.name}": "prompt": ${prompt.reason}`);
  }
  return prompt.text;
}
