/**
 * The run-role contract of ADR-0013 (ticket 01): every container a run starts
 * learns its role and its runtime-broker endpoint from host-set env, never
 * from an image layer or a marker file in the worktree. This module is the one
 * place that names the variables and their values, so the spawn plan (which
 * injects them), the `e spawn` process (which reads its own role marker), the
 * launch prompt (which points the agent at them) and the broker sidecar
 * (ticket 02, which listens where `E_BROKER_URL` points) cannot disagree.
 */

import {
  BROKER_ALIAS,
  BROKER_PORT,
  BROKER_URL_ENV,
  ROLE_ENV,
} from '../broker/constants.js';

// The variable names are owned by the broker module (a leaf that is bundled
// into the container programs); they are re-exported here for host-side callers.
export { BROKER_URL_ENV, ROLE_ENV };

/**
 * A container's place in the run tree: `parent` for the run the user (or
 * `serve`) started, `child` for a sibling requested through the runtime-broker.
 */
export type RunRole = 'parent' | 'child';

const RUN_ROLES: readonly RunRole[] = ['parent', 'child'];

/**
 * Parses a role value read from the environment. Unset or blank means
 * `parent` (the default for every run nobody marked a child); anything but
 * the two roles is a configuration error, reported with the variable it came
 * from so the message points at the right place.
 */
export function parseRunRole(
  value: string | undefined,
  source: string
): RunRole {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return 'parent';
  if ((RUN_ROLES as readonly string[]).includes(trimmed)) {
    return trimmed as RunRole;
  }
  throw new Error(
    `Unknown run role "${trimmed}" in ${source}; expected one of: ${RUN_ROLES.join(', ')}.`
  );
}

/**
 * Where an agent container reaches its broker. Mirrors the MCP endpoint rule
 * (`planMcpSelection`): in the shared egress namespace every sidecar is on the
 * agent's own loopback; on a private per-run network it is reached by alias.
 */
export function brokerUrl(
  sharedNetns: boolean,
  port: number = BROKER_PORT
): string {
  const host = sharedNetns ? 'localhost' : BROKER_ALIAS;
  return `http://${host}:${port}`;
}

/** The `-e` entries that deliver the role contract to one container. */
export function roleEnv(role: RunRole, url: string): string[] {
  return [`${ROLE_ENV}=${role}`, `${BROKER_URL_ENV}=${url}`];
}

/**
 * True when a `KEY=value` env entry sets one of the contract variables. The
 * host owns them for every run container, so a user `-e` naming one is
 * rejected up front rather than silently out-ranked by the host's entry.
 */
export function isRoleContractEntry(entry: string): boolean {
  const key = entry.split('=', 1)[0];
  return key === ROLE_ENV || key === BROKER_URL_ENV;
}

/**
 * The launch-prompt sentence that points a one-shot agent at the contract. It
 * promises only what the env delivers: the broker endpoint is named, not
 * guaranteed to answer (the sidecar itself is a later ticket of ADR-0013).
 */
export function runRoleInstructions(role: RunRole): string {
  return (
    `Your role in this run is "${role}": read it from $${ROLE_ENV}. ` +
    `$${BROKER_URL_ENV} names the runtime-broker endpoint for spawning sibling runs; ` +
    `if nothing answers there, or a request never leaves "requested", sibling ` +
    `spawning is unavailable in this run - record follow-up tasks as files in the ` +
    `worktree instead. Roles are set by the host ` +
    `through the environment; do not create or rely on parent/child marker files ` +
    `in the worktree.`
  );
}
