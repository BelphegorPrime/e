/**
 * **The `/api/runs` reader** (ADR-0010, ADR-0003, ADR-0013): everything the
 * BFF can say about a Run, as an interface over Runs and Spools instead of an
 * interface over an express request.
 *
 * A Run *is* a git branch, so every read starts by turning a URL tail into a
 * {@link RunName} through `fromBranch` - the one owner of that rule
 * (`core/identity/runName.ts`) - and the siblings view then reads that Run's
 * Spool on the host, the same records its Runtime-broker serves. Keeping the
 * parse ({@link parseRunRequest}) apart from the reads ({@link RunsApi}) is the
 * point of the module: both are callable, and assertable, without standing up
 * an HTTP server, and {@link runsRoutes} is left with nothing but status codes.
 *
 * Read-only on purpose (ADR-0010): the BFF observes runs, it never orchestrates
 * them, and there is deliberately no live timing or streaming-log view here -
 * the namespace stays extensible by layering a state store on top.
 */

import { Router } from 'express';

import { fromBranch, type RunName } from '../../core/identity/runName.js';
import { brokerSpoolDirFor } from '../../engine/runs/runBroker.js';
import {
  buildRunIndex,
  resolveRunRef,
  type RunIndexEntry,
} from '../../engine/runs/runIndex.js';
import type { Git, RunCommit, RunRef } from '../../ports/git/index.js';
import {
  STATUS_EVENTS_HEARTBEAT_MS,
  STATUS_EVENTS_POLL_MS,
} from '../../sidecars/broker/contract/constants.js';
import { streamStatusEvents } from '../../sidecars/broker/contract/events.js';
import {
  listRecords,
  readRunInfo,
} from '../../sidecars/broker/contract/spool.js';
import type { StatusResponse } from '../../sidecars/broker/contract/types.js';
import { NotFoundError, respondJson, respondNotFound } from './apiResponse.js';

/** Where the runs index and every per-run view hang off. */
const RUNS_PATH = '/api/runs';

/** What a `/api/runs/...` path asks to see of one Run. */
export type RunView = 'status' | 'logs' | 'siblings' | 'siblingEvents';

/**
 * The path suffix that selects each view, longest first. No suffix is the
 * Run's status, which is why the branch can only be recovered by stripping:
 * `e/<agent>/<slug>-N` is itself several segments.
 */
const VIEW_SUFFIXES: ReadonlyArray<readonly [string, RunView]> = [
  ['/siblings/events', 'siblingEvents'],
  ['/siblings', 'siblings'],
  ['/logs', 'logs'],
];

/** A `/api/runs/...` path read back as a Run and a view of it. */
export interface RunRequest {
  run: RunName;
  view: RunView;
}

/**
 * Reads `apiPath` as a per-run request, or `undefined` when it names no Run -
 * a foreign prefix, an empty tail, or a branch that is not `e/<agent>/<slug>-N`.
 *
 * Takes the path rather than an express route param because a branch spans
 * several segments: `*splat` hands those over as an array and loses the
 * branch. The resulting {@link RunName} is the normalized identity, so a
 * remote-tracking spelling in the URL resolves to the same Run.
 */
export function parseRunRequest(apiPath: string): RunRequest | undefined {
  const prefix = `${RUNS_PATH}/`;
  if (!apiPath.startsWith(prefix)) return undefined;
  const rest = apiPath.slice(prefix.length);
  const matched = VIEW_SUFFIXES.find(([suffix]) => rest.endsWith(suffix));
  const branch = matched ? rest.slice(0, -matched[0].length) : rest;
  const run = fromBranch(branch);
  return run ? { run, view: matched ? matched[1] : 'status' } : undefined;
}

/** A Run's status as `/api/runs/<branch>` answers it: its identity plus its branch tip. */
export interface RunStatus {
  branch: string;
  agent: string;
  slug: string;
  counter: number;
  /** How many commits the run branch carries. */
  commits: number;
  /** The branch tip, or null when no enumerated ref reaches it. */
  latest: RunCommit | null;
  local: boolean;
  pushed: boolean;
}

/** A Run's commit history as `/api/runs/<branch>/logs` answers it. */
export interface RunLogs {
  branch: string;
  commits: RunCommit[];
}

export interface RunsApiDeps {
  /** Git read source for the branch-backed index; the host executable in production. */
  git: Git;
  /** Where run Spools live (`<worktreesDir>/.broker/<runName>`). */
  worktreesDir: string;
}

/**
 * The Runs and Spools behind `/api/runs`. Git failures are thrown rather than
 * swallowed: a caller that wants them as a 500 wraps the call in
 * `respondJson`, and a caller that wants the exception (a test) gets it.
 */
export class RunsApi {
  constructor(private readonly deps: RunsApiDeps) {}

  /** Every run branch with its tip metadata, newest first. */
  index(): RunIndexEntry[] {
    return buildRunIndex(this.deps.git.listRunRefs('e'));
  }

  /** `run`'s status, or `undefined` when no branch of that name exists. */
  status(run: RunName): RunStatus | undefined {
    // One enumeration per read keeps status consistent with the index and
    // answers the `local`/`pushed` questions without extra git calls.
    const refs = this.deps.git.listRunRefs('e');
    const entry = buildRunIndex(refs).find(
      candidate => candidate.branch === run.branch
    );
    if (!entry) return undefined;
    const commits = this.commitsOf(refs, run);
    return {
      branch: entry.branch,
      agent: entry.agent,
      slug: entry.slug,
      counter: entry.counter,
      commits: commits.length,
      latest: commits[0] ?? null,
      local: entry.local,
      pushed: entry.pushed,
    };
  }

  /** `run`'s commit history, or `undefined` when no branch of that name exists. */
  logs(run: RunName): RunLogs | undefined {
    const refs = this.deps.git.listRunRefs('e');
    const known = buildRunIndex(refs).some(
      candidate => candidate.branch === run.branch
    );
    if (!known) return undefined;
    return { branch: run.branch, commits: this.commitsOf(refs, run) };
  }

  /**
   * The siblings of a live Run with a broker (ADR-0013/0015), read from its
   * Spool on the host. A Run without a Spool has no siblings - that is not an
   * error, it is a Run that was never given a `spawn-brother` skill.
   */
  siblings(run: RunName): StatusResponse {
    const spool = brokerSpoolDirFor(this.deps.worktreesDir, run);
    return { run: readRunInfo(spool), siblings: listRecords(spool) };
  }

  /** A branch's commits, read from its local head or, failing that, its remote twin. */
  private commitsOf(refs: RunRef[], run: RunName): RunCommit[] {
    const ref = resolveRunRef(refs, run.branch);
    return ref ? this.deps.git.runLog(ref.name) : [];
  }
}

/**
 * The `/api/runs` routes: turn the URL into a {@link RunRequest}, ask the
 * {@link RunsApi}, give the answer a status code. The sibling event stream is
 * the one view that writes to the response itself, because Server-Sent Events
 * outlive the handler.
 */
export function runsRoutes(runs: RunsApi): Router {
  const router = Router();

  router.get(RUNS_PATH, (_request, response) => {
    respondJson(response, () => ({ runs: runs.index() }));
  });

  // One route for every per-run view: the branch spans several segments, so
  // express cannot tell them apart by pattern.
  router.get(`${RUNS_PATH}/*splat`, (request, response) => {
    const parsed = parseRunRequest(request.path);
    if (!parsed) {
      respondNotFound(response);
      return;
    }
    const { run, view } = parsed;
    if (view === 'siblingEvents') {
      streamStatusEvents(request, response, {
        snapshot: () => runs.siblings(run),
        pollMs: STATUS_EVENTS_POLL_MS,
        heartbeatMs: STATUS_EVENTS_HEARTBEAT_MS,
      });
      return;
    }
    respondJson(response, () => {
      if (view === 'siblings') return runs.siblings(run);
      const body = view === 'logs' ? runs.logs(run) : runs.status(run);
      if (body === undefined) throw new NotFoundError();
      return body;
    });
  });

  return router;
}
