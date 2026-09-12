/**
 * Fixed facts of the **runtime-broker** sidecar (ADR-0013, ticket 02), shared
 * by three programs: the `e` CLI (which plans the sidecar, renders its build
 * context and seeds the `spawn-brother` skill), the broker server that runs
 * inside the `e-broker` container (bundled from `./server.ts`), and the skill
 * script that runs inside the agent container (bundled from `./cli.ts`). One
 * module, so a port, path or name changes in exactly one place.
 */

import type { MergeBackStatus } from './types.js';

/** Container env: the run role (`parent` | `child`), set by the host per container. */
export const ROLE_ENV = 'E_ROLE';

/** Container env: the runtime-broker base URL (`http://<host>:<port>`). */
export const BROKER_URL_ENV = 'E_BROKER_URL';

/** The image tag the broker sidecar is built from (`.e/broker/`). */
export const BROKER_IMAGE = 'e-broker';

/** The broker's alias on the run's private network (`http://runtime-broker:<port>`). */
export const BROKER_ALIAS = 'runtime-broker';

/**
 * The port the broker listens on. In the shared `e-egress` namespace
 * (ADR-0011) it shares loopback with OmniRoute (20128) and the egress API
 * (20129), so it takes the next fixed port.
 */
export const BROKER_PORT = 20130;

/**
 * Where the run's **spool** is bind-mounted inside the broker container. The
 * spool is the whole host/broker contract: the broker writes sibling requests
 * into it, the host `e` process (the only party with a container runtime and
 * git) reads them and writes status back. No socket crosses into any
 * container (ADR-0002).
 */
export const BROKER_SPOOL_MOUNT = '/var/lib/e-broker';

/** Env override of the spool directory, for running the server outside a container. */
export const BROKER_SPOOL_ENV = 'BROKER_SPOOL';

/** Spool layout: the run's identity, one file per request, one file per status. */
export const SPOOL_RUN_FILE = 'run.json';
export const SPOOL_REQUESTS_DIR = 'requests';
export const SPOOL_STATUS_DIR = 'status';
/** Spool layout: the sibling processes' stdout/stderr, one file per request. */
export const SPOOL_LOGS_DIR = 'logs';
/**
 * Spool layout: the parent agent's merge signals (ticket 07), one file per
 * request, written by the broker on `POST /merge/<id>` and consumed by the
 * host when it retries that sibling's merge-back.
 */
export const SPOOL_SIGNALS_DIR = 'signals';

/**
 * Where a parent agent reads a finished sibling's report, inside its own
 * worktree (`/workspace` in the container): `e-runs/<request id>/report.md`.
 * The host writes it there so the agent needs no host path and no git to
 * learn how the merge-back went (ADR-0013, ticket 07). It is committed with
 * the run's output like any other file in the worktree.
 */
export const RUN_REPORTS_DIR = 'e-runs';
export const RUN_REPORT_FILE = 'report.md';

/** The worktree-relative report path of sibling `id`, POSIX-joined for the container. */
export function runReportPath(id: string): string {
  return `${RUN_REPORTS_DIR}/${id}/${RUN_REPORT_FILE}`;
}

/**
 * The merge-back states a parent's signal (`POST /merge/<id>`) can move on:
 * a merge held over files in the way, or one in progress with conflict
 * markers. Anything else has nothing to retry (broker and host agree).
 */
export const MERGE_SIGNAL_STATES: readonly MergeBackStatus[] = [
  'held',
  'conflict',
];

/** Why a spool whose run is itself a sibling refuses requests (broker and host alike). */
export const DEPTH_LIMIT_MESSAGE =
  'Depth limit: a sibling run may not spawn children; siblings are requested through the parent run.';

/** The Store skill that teaches an agent to call the broker; selecting it plans the sidecar. */
export const SPAWN_BROTHER_SKILL = 'spawn-brother';

/** The skill's script file (the bundled `./cli.ts`), run with the harness image's `node`. */
export const SPAWN_BROTHER_SCRIPT = 'spawn-brother.mjs';
