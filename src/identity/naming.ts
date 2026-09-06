/**
 * **Container identity** — the single source of the deterministic names `e`
 * gives the things it builds and runs. Two concerns live here, both pure:
 *
 *  - **Image tags**: the `e-<kind>-<name>` convention shared by harness base
 *    images, derived agent images, and MCP sidecar images. One rule, one place,
 *    instead of a literal per harness plus a function per other kind.
 *  - **Run identity**: a {@link RunName} value derived from an Agent name, a
 *    prompt slug, and the run counter — the branch, the dashed run/container
 *    name, the private network, and each sidecar's container name. This replaces
 *    the untyped run-name string that used to be passed between `runSpawn` and
 *    `mcp` and re-derived by hand at each end (ADR-0003).
 *
 * This module imports nothing — the names are its whole implementation, so it
 * sits at the bottom of the dependency graph and every other module points at it.
 */

/** The kinds of image `e` tags, each namespaced so tags never collide across kinds. */
export type ImageKind = 'harness' | 'agent' | 'mcp';

/**
 * The image tag for a `kind`/`name` pair: `e-<kind>-<name>`, lowercased because
 * container image references must be lowercase (so the harness `claudeCode`
 * becomes `e-harness-claudecode`). The `e-harness-*` / `e-agent-*` / `e-mcp-*`
 * namespaces keep a harness, agent, and sidecar image from ever colliding.
 */
export function imageTag(kind: ImageKind, name: string): string {
  return `e-${kind}-${name.toLowerCase()}`;
}

/**
 * The branch prefix enumerated to find a run's counter: `e/<agent>/<slug>`. The
 * next run is `max(existing <prefix>-N) + 1` (see {@link maxRunCounter}); a
 * {@link RunName} for that counter carries the full branch and its derivations.
 */
export function runBranchPrefix(agent: string, slug: string): string {
  return `e/${agent}/${slug}`;
}

/**
 * A run's identity, derived once from `(agent, slug, counter)`. The branch is the
 * durable artifact (`e/<agent>/<slug>-N`); {@link name} is that branch with `/`
 * turned into `-`, used as the worktree directory, the container `--name`, and
 * the base for the private network and each sidecar's container name — so the
 * agent always reaches a sidecar at the stable alias while the container names
 * stay unique per run.
 */
export interface RunName {
  /** The durable git branch: `e/<agent>/<slug>-N`. */
  branch: string;
  /** The dashed run identity (branch with `/`→`-`): worktree dir, container `--name`. */
  name: string;
  /** The private per-run network: `<name>-net`. */
  network: string;
  /** The per-run container name for a sidecar reached at `alias`: `<name>-mcp-<alias>`. */
  sidecarContainer(alias: string): string;
}

/** Builds the {@link RunName} for a given Agent name, prompt slug, and run counter. */
export function runName(agent: string, slug: string, counter: number): RunName {
  const branch = `${runBranchPrefix(agent, slug)}-${counter}`;
  const name = branch.replace(/\//g, '-');
  return {
    branch,
    name,
    network: `${name}-net`,
    sidecarContainer: (alias: string) => `${name}-mcp-${alias}`,
  };
}

/**
 * Highest run counter `N` among `branches` matching `<prefix>-N`, or 0 if none.
 * Accepts both local (`e/<agent>/<slug>-2`) and remote-tracking
 * (`origin/e/<agent>/<slug>-2`) shortnames, so the counter never reuses a number
 * already taken on origin. The next run is `max + 1`.
 */
export function maxRunCounter(branches: string[], prefix: string): number {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match `<prefix>-<N>` at the end, allowing a leading `<remote>/` segment.
  const pattern = new RegExp(`(?:^|/)${escaped}-(\\d+)$`);
  let max = 0;
  for (const branch of branches) {
    const match = pattern.exec(branch);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}
