import type { Agent } from '../../core/agent/index.js';
import type { Git } from '../../ports/git/index.js';
import {
  branchPrefix,
  forParts,
  maxRunCounter,
  type RunName,
} from '../../core/identity/runName.js';
import { worktreePathFor } from './worktreesDir.js';

import { errorMessage } from '../../shared/utils/errors.js';
import { log } from '../../shared/utils/log.js';

/** How {@link nextRunName} looks for a free counter. */
export interface NextRunNameOptions {
  /**
   * The other repositories of the run namespace (`runNamespace.ts`, #208):
   * their container, session and worktree names are keyed by the run name
   * alone, so the counter starts past their runs too. One that cannot be
   * listed (moved, not a repository) is skipped.
   */
  runNamespace?: readonly Git[];
  /** Collisions stepped past before giving up. */
  maxAttempts?: number;
}

/**
 * Cuts the next available run branch from `base` and creates its worktree,
 * returning the Run's identity. The counter starts one past the highest
 * already used for this `e/<agent>/<slug>` prefix - locally or on any remote,
 * in this repository or any other of its namespace, so a number taken on
 * origin or next door is never reused - and steps forward on a collision,
 * because `Git.addWorktree` is atomic: two concurrent Spawns race for the
 * branch, or for the worktree path, which is host-wide, and the loser
 * retries rather than clobbering the winner.
 */
export async function nextRunName(
  git: Git,
  agent: Agent,
  slug: string,
  base: string,
  worktreesDir: string,
  options: NextRunNameOptions = {}
): Promise<RunName> {
  const { runNamespace = [], maxAttempts = 50 } = options;
  const prefix = branchPrefix(agent.name, slug);
  const taken = [
    ...git.listRunBranches(prefix),
    ...runNamespace.flatMap(repo => namespaceBranches(repo, prefix)),
  ];
  let counter = maxRunCounter(taken, prefix) + 1;
  let attempt = 0;

  while (true) {
    const run = forParts(agent.name, slug, counter);
    try {
      git.addWorktree({
        path: worktreePathFor(worktreesDir, run),
        branch: run.branch,
        base,
      });
      return run;
    } catch (err) {
      const isCollision = /already exists/i.test(errorMessage(err));
      if (!isCollision || attempt >= maxAttempts) {
        throw err;
      }
      counter++;
      attempt++;
    }
  }
}

/** Another repository's run branches for `prefix`; none when it cannot be read. */
function namespaceBranches(repo: Git, prefix: string): string[] {
  try {
    return repo.listRunBranches(prefix);
  } catch (err) {
    log.debug(
      `Not counting a namespace repository's runs: ${errorMessage(err)}`
    );
    return [];
  }
}
