/**
 * **Run identity** - the single owner of the deterministic names a Run gives
 * the things it creates: its git branch, its dashed run/container name, its
 * private network, and each Sidecar's container name (ADR-0003).
 *
 * The branch is the identity. It is the durable artifact a Run leaves behind
 * (ADR-0001), so every other name is derived from it: {@link fromBranch} is the
 * one real constructor and {@link forParts} only spells the branch out first.
 * Nothing outside this module re-derives a run name by hand - the host paths
 * (`worktreesDir.ts`, `runArtifacts.ts`, `runBroker.ts`), the runs index
 * (`runIndex.ts`), the BFF and the browser terminal all take a {@link RunName}.
 *
 * This module imports nothing - the names are its whole implementation, so it
 * sits at the bottom of the dependency graph and every other module points at it.
 */

/**
 * `[<remote>/]e/<agent>/<slug>-N`. The slug itself may contain hyphens and
 * digits, so the counter is taken from the trailing `-<N>`.
 */
const RUN_BRANCH = /^(?:([^/]+)\/)?e\/([^/]+)\/(.+)-(\d+)$/;

/** Escapes `value` for literal use inside a `RegExp`. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A Run's identity. The branch is the durable artifact (`e/<agent>/<slug>-N`);
 * {@link RunName.name} is that branch with `/` turned into `-`, used as the
 * worktree directory, the container `--name`, and the base for the private
 * network and each Sidecar's container name - so the agent always reaches a
 * Sidecar at its stable alias while the container names stay unique per Run.
 *
 * Plain data on purpose: a {@link RunName} is serialized (the BFF's `/api/runs`)
 * and compared field-by-field in tests, so no method hides on it - see
 * {@link sidecarContainerFor}.
 */
export interface RunName {
  /** The durable git branch: `e/<agent>/<slug>-N`, without any `<remote>/`. */
  branch: string;
  agent: string;
  slug: string;
  counter: number;
  /** The dashed run identity (branch with `/`->`-`): worktree dir, container `--name`. */
  name: string;
  /** The private per-run network: `<name>-net`. */
  network: string;
}

/**
 * The branch prefix enumerated to find a Run's counter: `e/<agent>/<slug>`.
 * The next Run is `max(existing <prefix>-N) + 1` (see {@link maxRunCounter}).
 */
export function branchPrefix(agent: string, slug: string): string {
  return `e/${agent}/${slug}`;
}

/**
 * The {@link RunName} for a branch short name. Accepts local (`e/...`) and
 * remote-tracking (`origin/e/...`) names, stripping the remote; anything that
 * is not `[<remote>/]e/<agent>/<slug>-N` is not a run branch and yields
 * `undefined`.
 */
export function fromBranch(shortName: string): RunName | undefined {
  const match = RUN_BRANCH.exec(shortName);
  if (!match) return undefined;
  const remote = match[1];
  // A leading segment of `e` is the run's own namespace, not a remote name:
  // `e/e/agent/slug-1` is not a run branch.
  if (remote === 'e') return undefined;
  const branch = shortName.slice(remote ? remote.length + 1 : 0);
  const name = branch.replace(/\//g, '-');
  return {
    branch,
    agent: match[2]!,
    slug: match[3]!,
    counter: Number(match[4]),
    name,
    network: `${name}-net`,
  };
}

/**
 * The {@link RunName} for an Agent name, prompt slug and run counter. Spells
 * the branch out and hands it to {@link fromBranch}, so there is exactly one
 * place that knows how a branch becomes every other name.
 *
 * Throws unless the branch reads back as the same three parts: an `agent`
 * containing `/` would otherwise parse as a shorter agent and a longer slug,
 * silently naming a different Run than the caller asked for.
 */
export function forParts(
  agent: string,
  slug: string,
  counter: number
): RunName {
  const run = fromBranch(`${branchPrefix(agent, slug)}-${counter}`);
  if (
    !run ||
    run.agent !== agent ||
    run.slug !== slug ||
    run.counter !== counter
  ) {
    throw new Error(
      `Not a run identity: agent "${agent}", slug "${slug}", counter ${counter}.`
    );
  }
  return run;
}

/**
 * The per-run container name for a Sidecar reached at `alias`:
 * `<name>-mcp-<alias>`. A free function rather than a method so
 * {@link RunName} stays plain, serializable data.
 */
export function sidecarContainerFor(run: RunName, alias: string): string {
  return `${run.name}-mcp-${alias}`;
}

/**
 * The per-run container name of the Runtime-broker Sidecar: `<name>-broker`
 * (ADR-0013). It has no alias segment because a Run has at most one broker.
 */
export function brokerContainerFor(run: RunName): string {
  return `${run.name}-broker`;
}

/**
 * An engine-side regex matching the primary container of *any* Run of
 * `agent`/`slug`, whatever its counter - the one place that needs a run name
 * without knowing which Run it is (the browser terminal finds its container by
 * name, ADR-0014). Anchored so a slug that merely prefixes another does not
 * match, and `/?` because engines report container names with a leading slash.
 */
export function namePattern(agent: string, slug: string): string {
  return `^/?e-${escapeRegex(agent)}-${escapeRegex(slug)}-[0-9]+$`;
}

/**
 * Highest run counter `N` among `branches` matching `<prefix>-N`, or 0 if none.
 * Accepts both local (`e/<agent>/<slug>-2`) and remote-tracking
 * (`origin/e/<agent>/<slug>-2`) short names, so the counter never reuses a
 * number already taken on origin. Sibling slugs that merely start with the
 * prefix (`fix` vs `fix-typo-3`) do not count. The next Run is `max + 1`.
 */
export function maxRunCounter(branches: string[], prefix: string): number {
  // `<prefix>-<N>` at the end, allowing exactly one leading `<remote>/` segment.
  const pattern = new RegExp(`^(?:[^/]+/)?${escapeRegex(prefix)}-(\\d+)$`);
  let max = 0;
  for (const branch of branches) {
    const match = pattern.exec(branch);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}
