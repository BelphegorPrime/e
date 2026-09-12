/**
 * The run-role *value*: what `parent` and `child` mean and how a string read
 * from the environment becomes one. It lives in `shared` because
 * `shared/utils/env.ts` parses `E_ROLE` like every other variable it owns,
 * and `shared` may not reach up into the run engine. The rest of the role
 * contract - the variable names, the broker URL rule, the `-e` entries and
 * the launch-prompt sentence - is the engine's (`engine/runs/runRole.ts`).
 */

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
