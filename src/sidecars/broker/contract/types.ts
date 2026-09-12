/** Wire and spool types of the runtime-broker (ADR-0013). Node built-ins only: bundled. */

/**
 * A sibling's lifecycle: the broker writes `requested`; the host advances the
 * rest. `canceled` and `rejected` (ADR-0015) are the host's answers to a
 * parent's `POST /cancel/<id>` and to a request it refuses after the broker
 * accepted it (the depth rule, re-checked host-side).
 */
export type SiblingState =
  | 'requested'
  | 'starting'
  | 'running'
  | 'done'
  | 'failed'
  | 'canceled'
  | 'rejected';

/**
 * The A2A task state a sibling record maps to (ADR-0015): the Agent2Agent
 * protocol's vocabulary, derived from the run state and the merge-back, so
 * an agent, the web UI and an A2A client all read the same lifecycle. See
 * `taskState.ts` for the mapping.
 */
export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'rejected';

/** `POST /spawn` body. */
export interface SpawnRequestBody {
  /** The Store agent (or bare harness) to run the sibling as. */
  agent: string;
  /** The sibling's whole task: goal, scope, acceptance criteria. */
  prompt: string;
}

/** A request as spooled by the broker (`requests/<id>.json`). */
export interface SpawnRequest extends SpawnRequestBody {
  /** `sib-NNN` (a sibling) or `a2a-NNN` (a task the A2A facade started), assigned in arrival order. */
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
  /**
   * Not attempted (`reason`): the sibling failed, exited non-zero, was
   * canceled or rejected, or was a remote A2A agent with no branch to merge
   * (its answer is in the report).
   */
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
  /** Why the sibling failed, was canceled or was rejected, when it was. */
  error?: string;
  /** The merge-back into the parent worktree, once the sibling has exited. */
  merge?: MergeBack;
  /** Where the parent agent reads the sibling's report, relative to its worktree (`e-runs/<id>/report.md`). */
  report?: string;
  /** A run of the user's own (never a sibling): whether its branch was pushed. */
  pushed?: boolean;
  /** A run of the user's own: the PR/MR opened for its branch, when one was. */
  pullRequestUrl?: string;
  /**
   * A remote A2A agent's answer (ADR-0015): the text of the artifacts it
   * returned. Such a sibling has no branch; the answer goes into the report.
   */
  answer?: string;
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

/** `202` body of `POST /cancel/<id>`: the parent's cancel is spooled for the host. */
export interface CancelAccepted {
  id: string;
  status: 'cancel-requested';
  /** Where to poll for the `canceled` state: `/status/<id>`. */
  statusPath: string;
}

/**
 * A request merged with whatever status the host has written for it, plus
 * the A2A task state derived from both (ADR-0015).
 */
export type SiblingRecord = SpawnRequest &
  Partial<Omit<SiblingStatusPatch, 'status'>> & {
    status: SiblingState;
    taskState: TaskState;
  };

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

/** `GET /status` body, and the `data` of every `status` event on `GET /status/events`. */
export interface StatusResponse {
  run: BrokerRunInfo | null;
  siblings: SiblingRecord[];
}

export interface ErrorResponse {
  error: string;
}
