/** Wire and spool types of the runtime-broker (ADR-0013). Node built-ins only: bundled. */

/** A sibling's lifecycle: the broker writes `requested`; the host advances the rest. */
export type SiblingState =
  'requested' | 'starting' | 'running' | 'done' | 'failed';

/** `POST /spawn` body. */
export interface SpawnRequestBody {
  /** The Store agent (or bare harness) to run the sibling as. */
  agent: string;
  /** The sibling's whole task: goal, scope, acceptance criteria. */
  prompt: string;
}

/** A request as spooled by the broker (`requests/<id>.json`). */
export interface SpawnRequest extends SpawnRequestBody {
  /** `sib-NNN`, assigned in arrival order. */
  id: string;
  /** ISO timestamp of arrival at the broker. */
  requestedAt: string;
}

/**
 * How far the host got folding a finished sibling's branch back into the
 * parent worktree (the **merge-back** of ADR-0013, ticket 07). Written into
 * the sibling's status once it has exited, and updated on every retry.
 */
export type MergeBackStatus =
  /** A merge commit landed; the sibling's files are in the parent worktree. */
  | 'merged'
  /** The branch added nothing beyond the parent's checkpoint; nothing to merge. */
  | 'up-to-date'
  /** In progress with conflict markers in `files`; the parent resolves them and signals. */
  | 'conflict'
  /** Not started: the parent's edits to `files` were in the way; the parent clears them and signals. */
  | 'held'
  /** Git refused for another reason (`reason`); no retry will help. */
  | 'failed'
  /** Not attempted: the sibling failed or exited non-zero (`reason`). */
  | 'skipped';

/** The merge-back of one sibling, as the host reports it in the status. */
export interface MergeBack {
  status: MergeBackStatus;
  /** `conflict`: the files carrying markers; `held`: the files the parent must clear first. */
  files?: string[];
  /** `held` / `failed` / `skipped`: why, in one sentence for the agent. */
  reason?: string;
}

/** What the host writes back (`status/<id>.json`) as it handles a request. */
export interface SiblingStatusPatch {
  status: SiblingState;
  /** The sibling's run branch (`e/<agent>/<slug>-N`), once assigned. */
  branch?: string;
  /** The sibling container's exit code, once it exited. */
  exitCode?: number;
  /** Why the sibling failed, when it did. */
  error?: string;
  /** The merge-back into the parent worktree, once the sibling has exited. */
  merge?: MergeBack;
  /** Where the parent agent reads the sibling's report, relative to its worktree (`e-runs/<id>/report.md`). */
  report?: string;
  /** ISO timestamp of the last host update. */
  updatedAt: string;
}

/** `202` body of `POST /merge/<id>`: the parent's signal is spooled for the host. */
export interface MergeSignalAccepted {
  id: string;
  status: 'merge-requested';
  /** Where to poll for the retried merge-back: `/status/<id>`. */
  statusPath: string;
}

/** A request merged with whatever status the host has written for it. */
export type SiblingRecord = SpawnRequest &
  Partial<Omit<SiblingStatusPatch, 'status'>> & { status: SiblingState };

/** The parent run's identity, written by the host before the broker starts (`run.json`). */
export interface BrokerRunInfo {
  /** The dashed run name (container `--name`). */
  name: string;
  /** The run branch `e/<agent>/<slug>-N`. */
  branch: string;
  /** The Store agent the run executes. */
  agent: string;
  /** The run's role (`E_ROLE`). */
  role: 'parent' | 'child';
  /** Fan-out bound: siblings in flight at once (`config.json` `maxSiblings`). */
  maxSiblings: number;
}

/** `202` body of `POST /spawn`. */
export interface SpawnAccepted {
  id: string;
  status: 'requested';
  /** Where to poll: `/status/<id>`. */
  statusPath: string;
}

/** `GET /status` body. */
export interface StatusResponse {
  run: BrokerRunInfo | null;
  siblings: SiblingRecord[];
}

export interface ErrorResponse {
  error: string;
}
