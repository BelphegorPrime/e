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
import { errorMessage } from '../../shared/utils/errors.js';
import { log } from '../../shared/utils/log.js';
import {
  listDead,
  listLedger,
  listQueue,
  type DeadRequest,
  type DeathStage,
  type LedgerEntry,
  type RunRequest as QueuedRequest,
  type RunsDirs,
} from '../../engine/queue/runsSpool.js';

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
  /** The repository the run is in, when it is not `serve`'s own (#208). */
  repo?: string;
}

/** A Run's commit history as `/api/runs/<branch>/logs` answers it. */
export interface RunLogs {
  branch: string;
  commits: RunCommit[];
}

/** Another repository of the run namespace, whose runs the index lists. */
export interface RunRepository {
  path: string;
  git: Git;
}

export interface RunsApiDeps {
  /** Git read source for the branch-backed index; the host executable in production. */
  git: Git;
  /**
   * The other repositories of the serving Store's run namespace (#208), read
   * afresh at each request so a trigger added under a running `serve`
   * counts. Run names are unique across them and `git`'s (the counter spans
   * them all), so a branch names one run wherever it is found.
   */
  runNamespace?: () => readonly RunRepository[];
  /** Where run Spools live (`<worktreesDir>/.broker/<runName>`). */
  worktreesDir: string;
  /**
   * The serving Store's run queue and ledger (ADR-0016 section 6), whose
   * pending requests and live runs join the index; absent, the index is
   * branches only.
   */
  runs?: RunsDirs;
}

/** What the ledger adds to a branch run while it is live or just ended. */
export type LedgerView = Pick<
  LedgerEntry,
  | 'state'
  | 'exitCode'
  | 'outcome'
  | 'reason'
  | 'pushed'
  | 'pullRequestUrl'
  | 'gateRemovals'
  | 'startedAt'
  | 'endedAt'
  | 'error'
>;

/**
 * A run of the index, with the repository it is in when that is not
 * `serve`'s own: another of the run namespace (#208).
 */
export type IndexedRun = RunIndexEntry & { repo?: string };

/** A run with a branch, and what the ledger knows of it, if anything. */
export type BranchRunItem = IndexedRun & Partial<LedgerView> & { id?: string };

/**
 * Something that is not a branch: a request still `queued`, a run `serve`
 * has `claimed` that has not cut its branch, or a `dead` request that died
 * before it had one. Metadata only - the index never carries a payload body.
 */
export interface PendingRunItem {
  branch: null;
  state: 'queued' | 'claimed' | 'dead';
  /** The request id, `trg-<ulid>`. */
  id: string;
  agent: string;
  trigger?: string;
  /** The dedup key: what "did my webhook fire?" looks for. */
  key?: string;
  enqueuedAt?: string;
  claimedAt?: string;
  /** A dead request's stage (`expired`, `overflow`, `base`, `launch`), reason and time. */
  stage?: DeathStage;
  reason?: string;
  diedAt?: string;
}

/** One entry of `GET /api/runs`: one list, one state machine, `queued -> running -> terminal`. */
export type RunListItem = BranchRunItem | PendingRunItem;

/**
 * Joins the branch index with the ledger and the queue: pending requests and
 * claims first (oldest first, the order they will start in), then dead
 * requests (oldest death first), then branch runs newest first, each carrying
 * its ledger state where the ledger has one.
 */
export function runList(
  index: IndexedRun[],
  ledger: LedgerEntry[],
  queue: QueuedRequest[],
  dead: DeadRequest[] = []
): RunListItem[] {
  const byBranch = new Map(
    ledger
      .filter(entry => entry.run !== null)
      .map(entry => [entry.run as string, entry])
  );
  const pending: PendingRunItem[] = [
    ...queue.map((request): PendingRunItem => ({
      branch: null,
      state: 'queued',
      id: request.id,
      agent: request.agent,
      trigger: request.trigger,
      key: request.key,
      enqueuedAt: request.enqueuedAt,
    })),
    ...ledger
      .filter(entry => entry.run === null && entry.state === 'claimed')
      .map((entry): PendingRunItem => ({
        branch: null,
        state: 'claimed',
        id: entry.id,
        agent: entry.agent,
        ...(entry.request
          ? {
              trigger: entry.request.trigger,
              key: entry.request.key,
              enqueuedAt: entry.request.enqueuedAt,
            }
          : {}),
        ...(entry.claimedAt ? { claimedAt: entry.claimedAt } : {}),
      })),
    ...dead.map(({ request, stage, reason, diedAt }): PendingRunItem => ({
      branch: null,
      state: 'dead',
      id: request.id,
      agent: request.agent,
      trigger: request.trigger,
      key: request.key,
      enqueuedAt: request.enqueuedAt,
      stage,
      reason,
      diedAt,
    })),
  ];
  const branches = index.map((run): BranchRunItem => {
    const entry = byBranch.get(run.branch);
    if (!entry) return run;
    const view: Partial<LedgerView> & { id: string } = {
      id: entry.id,
      state: entry.state,
    };
    for (const key of [
      'exitCode',
      'outcome',
      'reason',
      'pushed',
      'pullRequestUrl',
      'gateRemovals',
      'startedAt',
      'endedAt',
      'error',
    ] as const) {
      if (entry[key] !== undefined) {
        (view as Record<string, unknown>)[key] = entry[key];
      }
    }
    return { ...run, ...view };
  });
  return [...pending, ...branches];
}

/**
 * The Runs and Spools behind `/api/runs`. Git failures are thrown rather than
 * swallowed: a caller that wants them as a 500 wraps the call in
 * `respondJson`, and a caller that wants the exception (a test) gets it.
 */
export class RunsApi {
  constructor(private readonly deps: RunsApiDeps) {}

  /** Every pending request, live claim and dead request, then every run branch newest first, with its ledger state. */
  index(): RunListItem[] {
    const index = this.branchIndex(this.sources());
    const dirs = this.deps.runs;
    if (!dirs) return index;
    return runList(index, listLedger(dirs), listQueue(dirs), listDead(dirs));
  }

  /** `run`'s status, or `undefined` when no branch of that name exists. */
  status(run: RunName): RunStatus | undefined {
    // One enumeration per read keeps status consistent with the index and
    // answers the `local`/`pushed` questions without extra git calls.
    const found = this.find(run);
    if (!found) return undefined;
    const { entry } = found;
    const commits = this.commitsOf(found, run);
    return {
      branch: entry.branch,
      agent: entry.agent,
      slug: entry.slug,
      counter: entry.counter,
      commits: commits.length,
      latest: commits[0] ?? null,
      local: entry.local,
      pushed: entry.pushed,
      ...(found.repo !== undefined ? { repo: found.repo } : {}),
    };
  }

  /** `run`'s commit history, or `undefined` when no branch of that name exists. */
  logs(run: RunName): RunLogs | undefined {
    const found = this.find(run);
    if (!found) return undefined;
    return { branch: run.branch, commits: this.commitsOf(found, run) };
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
  private commitsOf(source: RefSource, run: RunName): RunCommit[] {
    const ref = resolveRunRef(source.refs, run.branch);
    return ref ? source.git.runLog(ref.name) : [];
  }

  /**
   * Every repository's run refs, `serve`'s own first, read lazily so a
   * lookup stops at the repository that has the run. Its own failing (in a
   * repository) is a failed read; another's (moved, not a repository) only drops its runs,
   * so one stale trigger `repo` cannot take the index down.
   */
  private *sources(): Generator<RefSource> {
    // A home Store's `serve` may stand outside any repository: then only
    // its namespace has runs.
    if (this.deps.git.isRepo()) {
      yield { git: this.deps.git, refs: this.deps.git.listRunRefs('e') };
    }
    for (const repository of this.deps.runNamespace?.() ?? []) {
      let refs: RunRef[];
      try {
        refs = repository.git.listRunRefs('e');
      } catch (err) {
        log.debug(
          `Not listing the runs of ${repository.path}: ${errorMessage(err)}`
        );
        continue;
      }
      yield { repo: repository.path, git: repository.git, refs };
    }
  }

  /**
   * The runs of every source, newest first. A branch found twice is one run
   * (the counter spans every repository, so only the same repository listed
   * twice repeats one): the first source's wins, `serve`'s own before any.
   */
  private branchIndex(sources: Iterable<RefSource>): IndexedRun[] {
    const seen = new Set<string>();
    const entries: IndexedRun[] = [];
    for (const source of sources) {
      for (const entry of buildRunIndex(source.refs)) {
        if (seen.has(entry.branch)) continue;
        seen.add(entry.branch);
        entries.push(
          source.repo !== undefined ? { ...entry, repo: source.repo } : entry
        );
      }
    }
    // ISO-8601 strict timestamps compare lexicographically.
    entries.sort((a, b) => b.committerDate.localeCompare(a.committerDate));
    return entries;
  }

  /** The first repository holding `run`'s branch, and its index entry there. */
  private find(
    run: RunName
  ): (RefSource & { entry: RunIndexEntry }) | undefined {
    for (const source of this.sources()) {
      const entry = buildRunIndex(source.refs).find(
        candidate => candidate.branch === run.branch
      );
      if (entry) return { ...source, entry };
    }
    return undefined;
  }
}

/** One repository's run refs, and the git that reads its logs. */
interface RefSource {
  /** Absent for `serve`'s own repository. */
  repo?: string;
  git: Git;
  refs: RunRef[];
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
