import { readPath } from './match.js';

/**
 * Prompt construction for a trigger (ADR-0016). **A prompt cannot be
 * sanitized**: to a model, any interpolated text is instruction-shaped, and
 * escaping defends against HTML rather than against "ignore previous
 * instructions". The prompt is also the one thing separating an autonomous run
 * from a hand-typed one - whoever can write into it starts a run holding your
 * credentials.
 *
 * So the dividing line is that **identifiers can be validated and prose
 * cannot**. `issue.number` is a number or it is nothing; `issue.title` is
 * whatever a stranger typed. Only the paths below interpolate, each against
 * its own pattern, and a value that fails is never coerced or truncated - the
 * event is dropped.
 *
 * Fencing prose in delimiters plus a "this is untrusted" preamble was
 * rejected: the delimiter is itself just text in the prompt, and closing it is
 * the first thing an attacker tries. An agent that wants the whole payload
 * reads it from the read-only mount instead.
 *
 * Not Mustache, though it is a dependency: its escaping is built for HTML, it
 * renders an unknown key as the empty string where this must refuse, and the
 * whole point here is a fixed whitelist rather than a template language.
 */

/** Payload paths that may reach a prompt, each with the shape it must have. */
export const INTERPOLABLE: Record<string, RegExp> = {
  'issue.number': /^[0-9]+$/,
  'pull_request.number': /^[0-9]+$/,
  ref: /^[A-Za-z0-9._/-]+$/,
  base_ref: /^[A-Za-z0-9._/-]+$/,
  'pull_request.head.ref': /^[A-Za-z0-9._/-]+$/,
  sha: /^[0-9a-f]{7,40}$/,
  after: /^[0-9a-f]{7,40}$/,
  'sender.login': /^[A-Za-z0-9-]+$/,
  'label.name': /^[A-Za-z0-9 ._-]+$/,
  'repository.full_name': /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/,
};

/** Values the host generates itself, so no stranger ever wrote them. */
const HOST_VALUES = ['trigger', 'tick'] as const;

/** `{{ path }}`, with whatever spacing the author used. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** What the caller needs to render one trigger's prompt. */
export interface PromptContext {
  /** The delivery body, when there is one; a cron tick has none. */
  payload?: unknown;
  /** The trigger's id. */
  trigger: string;
  /** The scheduled time, for a cron trigger. */
  tick?: string;
}

/** A rendered prompt, or the reason this event is dropped. */
export type PromptResult =
  { ok: true; text: string } | { ok: false; reason: string };

/** Renders a trigger's prompt template, refusing anything off the whitelist. */
export function renderTriggerPrompt(
  template: string,
  ctx: PromptContext
): PromptResult {
  let failure: string | undefined;

  const text = template.replace(PLACEHOLDER, (_whole, path: string) => {
    if (failure) return '';

    if ((HOST_VALUES as readonly string[]).includes(path)) {
      const value = path === 'trigger' ? ctx.trigger : ctx.tick;
      if (value === undefined || value === '') {
        failure = `{{${path}}} has no value for this event`;
        return '';
      }
      return value;
    }

    const pattern = INTERPOLABLE[path];
    if (!pattern) {
      failure = `{{${path}}} is not interpolable: only validated identifiers reach a prompt, and free prose never does (whitelist: ${Object.keys(INTERPOLABLE).join(', ')})`;
      return '';
    }
    if (ctx.payload === undefined) {
      failure = `{{${path}}} needs an event payload, and this event carries none`;
      return '';
    }
    const raw = readPath(ctx.payload, path);
    const value =
      typeof raw === 'string' || typeof raw === 'number'
        ? String(raw)
        : undefined;
    if (value === undefined) {
      failure = `{{${path}}} is missing from the payload`;
      return '';
    }
    if (!pattern.test(value)) {
      failure = `{{${path}}} does not match ${pattern}; refusing to coerce or truncate it`;
      return '';
    }
    return value;
  });

  return failure ? { ok: false, reason: failure } : { ok: true, text };
}
