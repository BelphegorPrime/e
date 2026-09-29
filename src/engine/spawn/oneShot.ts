import fs from 'fs';
import path from 'path';
import type { Git } from '../../ports/git/index.js';
import type { Trigger, TriggerContext } from '../../core/trigger/index.js';
import { parseTriggerFiles } from '../../core/trigger/load.js';
import {
  baseError,
  baseRefCandidates,
  branchOfRef,
  EVENT_PAYLOAD_MAX_BYTES,
  isPullRef,
  oneShotEvent,
  oneShotRefusal,
  renderBaseName,
  renderOneShotPrompt,
  requireSameBase,
  tickStamp,
} from '../../core/trigger/oneShot.js';
import {
  triggerConfigPath,
  triggerPromptPath,
} from '../../core/store/paths.js';
import { errorMessage } from '../../shared/utils/errors.js';
import type { RunBase } from '../runs/runSpawn.js';

/**
 * **The one-shot shape** (ADR-0016 section 13): `e spawn --trigger <name>
 * [--event <path>]` turned into the agent, prompt and base of one ordinary
 * run - or into no run at all. Everything `serve` would own around it (the
 * queue, slots, dedup, the ledger) is void here: the outer scheduler owns it.
 *
 * **The declaration is read from `base`**, never from the working tree. In a
 * `pull_request` job every file but the workflow comes from the head, so a
 * `trigger.json` on disk is whatever the PR's author wrote. The default
 * branch is the anchor: its declaration says what `base` is, the run cuts
 * from that base, and the declaration used is the one committed there - which
 * must agree on `base`, or the two would name different bases.
 *
 * This module only reads - the refs, the declarations, the payload - and
 * hands each result to the pure decisions in `core/trigger/oneShot.ts`.
 */

export interface OneShotInput {
  /** The trigger's id: its directory under `.e/triggers/`. */
  name: string;
  /** The Store root; its `.e/` must be committed in the repository. */
  root: string | undefined;
  /** What the Store knows, for the load-time checks; `repoLocal` must be true. */
  context: TriggerContext;
  /** `--event`: the payload file, when the pipeline has one. */
  eventPath?: string;
  /** The provider's event name for the payload (`--event-name`, `$GITHUB_EVENT_NAME`). */
  eventName?: string;
  /** Now, for `{{tick}}`. */
  now: Date;
}

/** One run to start, or the reason none is. */
export type OneShotResolution =
  | {
      kind: 'run';
      trigger: Trigger;
      /** The rendered prompt. */
      prompt: string;
      base: RunBase;
      /** The payload file to mount at `/run/e/event.json`, when one was used. */
      eventFile?: string;
      /** Things the human should know that do not stop the run. */
      warnings: string[];
    }
  | { kind: 'skip'; reason: string };

/** Reads and parses one declaration as committed at `ref`. */
function declarationAt(
  git: Git,
  ref: string,
  input: OneShotInput & { root: string }
): Trigger {
  const file = triggerConfigPath(input.name, input.root);
  const where = `${ref}:${path.relative(input.root, file)}`;
  const json = git.readFileAt(ref, file);
  if (json === undefined) {
    throw new Error(
      `Trigger "${input.name}" is not declared at ${ref} (${path.relative(input.root, file)}): one-shot reads the declaration from base, never from the working tree, so it must be committed there`
    );
  }
  const loaded = parseTriggerFiles(
    input.name,
    where,
    json,
    git.readFileAt(ref, triggerPromptPath(input.name, input.root)),
    input.context
  );
  if (!loaded.trigger) throw new Error(loaded.error);
  return loaded.trigger;
}

/**
 * Applies the base rule to a rendered name: a ref of the target repository,
 * resolved here, and never a pull request's.
 */
function resolveBase(git: Git, name: string): RunBase {
  const candidates = baseRefCandidates(name);
  if (!candidates.ok) throw baseError(candidates.reason);
  for (const ref of candidates.candidates) {
    const sha = git.resolveCommit(ref);
    if (sha === undefined) continue;
    if (isPullRef(ref)) {
      throw baseError(
        `base "${name}" resolved to ${ref}, a pull request ref, which holds unreviewed code`
      );
    }
    return { ref, sha, branch: branchOfRef(ref) };
  }
  throw baseError(
    `base "${name}" does not resolve to a branch or tag of the target repository (tried ${candidates.candidates.join(', ')}); in CI, check out with fetch-depth: 0`
  );
}

/** Reads the payload file: bounded like the listener's, and JSON or nothing. */
function readPayload(file: string): unknown {
  const size = fs.statSync(file).size;
  if (size > EVENT_PAYLOAD_MAX_BYTES) {
    throw new Error(
      `--event ${file} is larger than ${EVENT_PAYLOAD_MAX_BYTES} bytes, the listener's cap`
    );
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(`--event ${file} is not JSON: ${errorMessage(err)}`, {
      cause: err,
    });
  }
}

/**
 * Turns `--trigger <name> [--event <path>]` into one run, or into the reason
 * there is none. Throws on everything that is an error rather than a
 * non-match: a declaration that cannot load, a base the rule refuses, a
 * payload the prompt cannot take.
 */
export function resolveOneShot(
  git: Git,
  input: OneShotInput
): OneShotResolution {
  const { root } = input;
  if (root === undefined || input.context.repoLocal !== true) {
    throw new Error(
      `--trigger needs a repo-local store (.e/ committed in the repository): one-shot reads the declaration from base, and a home store is in no repository`
    );
  }
  if (!git.isRepo()) {
    throw new Error(
      'e spawn --trigger must be run inside a git repository - the declaration is read from base.'
    );
  }
  const rooted = { ...input, root };

  const defaultRef = git.defaultBranchRef();
  if (defaultRef === undefined) {
    throw baseError(
      "cannot determine the repository's default branch: origin/HEAD is unset and origin did not name one; set it once with `git remote set-head origin <branch>`, which needs no network"
    );
  }
  const defaultBase = resolveBase(git, defaultRef);
  const anchor = declarationAt(git, defaultBase.ref, rooted);

  const { event, warnings } = oneShotEvent(
    anchor,
    input.eventPath !== undefined ? readPayload(input.eventPath) : undefined,
    input.eventName
  );
  const anchorRefusal = oneShotRefusal(anchor, event);
  if (anchorRefusal) return { kind: 'skip', reason: anchorRefusal };

  const tick = tickStamp(input.now);
  let base = defaultBase;
  let trigger = anchor;
  const baseName = renderBaseName(anchor, event, tick);
  if (baseName !== undefined) {
    base = resolveBase(git, baseName);
    if (base.ref !== defaultBase.ref) {
      trigger = declarationAt(git, base.ref, rooted);
      requireSameBase(trigger, anchor, base.ref, defaultBase.ref);
      const baseRefusal = oneShotRefusal(trigger, event);
      if (baseRefusal) return { kind: 'skip', reason: baseRefusal };
    }
  }

  return {
    kind: 'run',
    trigger,
    prompt: renderOneShotPrompt(trigger, event, tick),
    base,
    ...(event.payload !== undefined ? { eventFile: input.eventPath } : {}),
    warnings,
  };
}
