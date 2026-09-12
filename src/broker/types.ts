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

/** What the host writes back (`status/<id>.json`) as it handles a request. */
export interface SiblingStatusPatch {
  status: SiblingState;
  /** The sibling's run branch (`e/<agent>/<slug>-N`), once assigned. */
  branch?: string;
  /** The sibling container's exit code, once it exited. */
  exitCode?: number;
  /** Why the sibling failed, when it did. */
  error?: string;
  /** ISO timestamp of the last host update. */
  updatedAt: string;
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
