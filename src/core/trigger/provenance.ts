import { readPath } from './match.js';
import { INTERPOLABLE } from './prompt.js';

/**
 * **Provenance in git** (ADR-0016 section 9): a machine-started run says so,
 * in two trailers on every commit `e` writes for it - checkpoint and
 * merge-back commits included, because the trailer says _this commit arose in
 * this run_, not _the trigger wrote these lines_:
 *
 * ```
 * E-Trigger: nightly
 * E-Event: github:issue_comment.created:8e9a1c2d-....
 * ```
 *
 * A manual `e spawn` gets none: absence is the statement, and it makes
 * `git log --grep E-Trigger` mean exactly "machine-started".
 *
 * **Injection is closed at the acceptance boundary, not at commit time.** The
 * HMAC signs the body, not the headers, so a delivery id with a newline in it
 * would forge trailers. {@link acceptEvent} runs where a request is accepted,
 * before anything is written; {@link withProvenance} then composes values that
 * are already safe and knows no sanitisation at all. The git port stays dumb
 * (ADR-0002) and `git interpret-trailers` buys nothing on pre-validated
 * values.
 *
 * Nothing in `e` parses the trailer in v1, so the grammar stays free to change.
 */

/** The shape a source's own event id must have to reach a trailer. */
export const EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * The shape of a source or event name: the id's alphabet without the colon,
 * which separates the three parts of `E-Event`.
 */
export const EVENT_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** What started a run, as the `E-Event` trailer names it. */
export interface ProvenanceEvent {
  /** `github`, `cron`, `workflow`, ... */
  source: string;
  /** The provider's event name, `tick`, or the workflow's name. */
  event: string;
  /**
   * The source's own identity for this event: a delivery id, the scheduled
   * tick, a CI run id. Never the coarsened dedup value - that is a coalescing
   * policy, and would give every run against issue 42 the same id.
   */
  id: string;
}

/** A triggered run's provenance: absent for a manual run. */
export interface Provenance {
  /** The trigger's id (its directory name). */
  trigger: string;
  event: ProvenanceEvent;
  /**
   * The event's page, derived from validated identifiers (never a URL out of
   * the payload): the issue or PR a delivery is about, a CI run. For the PR
   * block only; no trailer carries it.
   */
  url?: string;
}

/**
 * A source or event name reduced to {@link EVENT_NAME_PATTERN}. These are
 * descriptive rather than identities, so a lossy spelling is acceptable where
 * a lossy id would not be: `Nightly agent` reads `Nightly-agent`.
 */
function eventName(value: string): string {
  const name = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return name === '' ? 'unknown' : name;
}

/**
 * The event as it may be written down: an id outside {@link EVENT_ID_PATTERN}
 * is replaced by `fallbackId` (the request's own ULID) - never coerced or
 * truncated, since a mangled id would name some other delivery. The event is
 * still accepted: a rejected delivery is lost for good.
 */
export function acceptEvent(
  event: ProvenanceEvent,
  fallbackId: string
): ProvenanceEvent {
  return {
    source: eventName(event.source),
    event: eventName(event.event),
    id: EVENT_ID_PATTERN.test(event.id) ? event.id : fallbackId,
  };
}

/** `<source>:<event>:<id>`, the value of `E-Event`. */
export function eventTrailerValue(event: ProvenanceEvent): string {
  return `${event.source}:${event.event}:${event.id}`;
}

/**
 * Reads an `E-Event` value back, for a process boundary (a sibling inherits
 * its parent's through the environment); undefined when any part is not of
 * its shape. Unambiguous because only the id may contain a colon.
 */
export function parseEventTrailerValue(
  value: string
): ProvenanceEvent | undefined {
  const [source, event, ...rest] = value.split(':');
  const id = rest.join(':');
  if (
    rest.length === 0 ||
    !EVENT_NAME_PATTERN.test(source) ||
    !EVENT_NAME_PATTERN.test(event) ||
    !EVENT_ID_PATTERN.test(id)
  ) {
    return undefined;
  }
  return { source, event, id };
}

/** The two trailers, one per line. */
export function provenanceTrailers(provenance: Provenance): string {
  return `E-Trigger: ${provenance.trigger}\nE-Event: ${eventTrailerValue(provenance.event)}`;
}

/** A commit message: `subject`, then the trailers after a blank line; the bare subject for a manual run. */
export function withProvenance(
  subject: string,
  provenance: Provenance | undefined
): string {
  return provenance
    ? `${subject}\n\n${provenanceTrailers(provenance)}`
    : subject;
}

/** A forge's base URL: scheme, host and an optional port, nothing more. */
const SERVER_URL = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;
const NUMBER = /^[0-9]+$/;
const FULL_NAME = INTERPOLABLE['repository.full_name'];

/** A payload value as the text it is written as, when it is text at all. */
function textAt(payload: unknown, path: string): string | undefined {
  const value = readPath(payload, path);
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : undefined;
}

/**
 * The page a webhook delivery is about: its issue, its pull request, else its
 * repository - built from `repository.full_name` and the numbers, each against
 * its pattern. Never `html_url`, or anything else a payload spells as a URL:
 * the block this lands in is rendered.
 */
export function webhookEventUrl(
  source: string,
  payload: unknown
): string | undefined {
  if (source !== 'github') return undefined;
  const repo = textAt(payload, 'repository.full_name');
  if (repo === undefined || !FULL_NAME.test(repo)) return undefined;
  const base = `https://github.com/${repo}`;
  const pull = textAt(payload, 'pull_request.number');
  if (pull !== undefined && NUMBER.test(pull)) return `${base}/pull/${pull}`;
  const issue = textAt(payload, 'issue.number');
  if (issue !== undefined && NUMBER.test(issue)) {
    return `${base}/issues/${issue}`;
  }
  return base;
}

/** What a CI job says about itself, as far as `e` reads it (GitHub Actions'). */
export interface WorkflowFacts {
  /** `GITHUB_WORKFLOW`: the workflow's name. */
  workflow?: string;
  /** `GITHUB_RUN_ID`. */
  runId?: string;
  /** `GITHUB_SERVER_URL`. */
  serverUrl?: string;
  /** `GITHUB_REPOSITORY`: `owner/repo`. */
  repository?: string;
}

/**
 * The event of a one-shot run (ADR-0016 section 13): `workflow:<workflow
 * name>:<run id>`, and the run's page. Accepted here, the one-shot edge,
 * exactly as a delivery is at the queue: a run id off its pattern - or none,
 * outside a CI `e` knows - is `fallbackId`, and no URL is built from it.
 */
export function workflowEvent(
  facts: WorkflowFacts,
  fallbackId: string
): { event: ProvenanceEvent; url?: string } {
  const event = acceptEvent(
    {
      source: 'workflow',
      event: facts.workflow ?? 'one-shot',
      id: facts.runId ?? fallbackId,
    },
    fallbackId
  );
  const { serverUrl, repository, runId } = facts;
  const linkable =
    serverUrl !== undefined &&
    SERVER_URL.test(serverUrl) &&
    repository !== undefined &&
    FULL_NAME.test(repository) &&
    runId !== undefined &&
    NUMBER.test(runId);
  return linkable
    ? { event, url: `${serverUrl}/${repository}/actions/runs/${runId}` }
    : { event };
}

/** An event page as it may be written down: the shapes the two builders above produce. */
const EVENT_URL =
  /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._/-]*)?$/;

/** A trigger's id as it may reach a trailer: its directory name, which the loader holds to this. */
export const TRIGGER_NAME_PATTERN = EVENT_NAME_PATTERN;

/** Provenance as a process boundary carries it (a child's environment). */
export interface ProvenanceStrings {
  trigger: string;
  event: string;
  url?: string;
}

/** Flattens provenance for a child process. */
export function provenanceStrings(provenance: Provenance): ProvenanceStrings {
  return {
    trigger: provenance.trigger,
    event: eventTrailerValue(provenance.event),
    ...(provenance.url !== undefined ? { url: provenance.url } : {}),
  };
}

/**
 * Reads provenance back on the far side of a process boundary. The values
 * were accepted upstream, so a part that does not fit is not a stranger's
 * input but a broken handover: it throws rather than write a trailer it
 * cannot vouch for.
 */
export function provenanceFromStrings(raw: ProvenanceStrings): Provenance {
  const event = parseEventTrailerValue(raw.event);
  if (!TRIGGER_NAME_PATTERN.test(raw.trigger) || !event) {
    throw new Error(
      `Malformed provenance: trigger ${JSON.stringify(raw.trigger)}, event ${JSON.stringify(raw.event)}`
    );
  }
  if (raw.url !== undefined && !EVENT_URL.test(raw.url)) {
    throw new Error(
      `Malformed provenance: event URL ${JSON.stringify(raw.url)}`
    );
  }
  return {
    trigger: raw.trigger,
    event,
    ...(raw.url !== undefined ? { url: raw.url } : {}),
  };
}
