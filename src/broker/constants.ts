/**
 * Fixed facts of the **runtime-broker** sidecar (ADR-0013, ticket 02), shared
 * by three programs: the `e` CLI (which plans the sidecar, renders its build
 * context and seeds the `spawn-brother` skill), the broker server that runs
 * inside the `e-broker` container (bundled from `./server.ts`), and the skill
 * script that runs inside the agent container (bundled from `./cli.ts`). One
 * module, so a port, path or name changes in exactly one place.
 */

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

/** Why a spool whose run is itself a sibling refuses requests (broker and host alike). */
export const DEPTH_LIMIT_MESSAGE =
  'Depth limit: a sibling run may not spawn children; siblings are requested through the parent run.';

/** The Store skill that teaches an agent to call the broker; selecting it plans the sidecar. */
export const SPAWN_BROTHER_SKILL = 'spawn-brother';

/** The skill's script file (the bundled `./cli.ts`), run with the harness image's `node`. */
export const SPAWN_BROTHER_SCRIPT = 'spawn-brother.mjs';
