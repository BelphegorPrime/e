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

/**
 * Cuts the next available run branch from `base` and creates its worktree,
 * returning the Run's identity. The counter starts one past the highest
 * already used for this `e/<agent>/<slug>` prefix - locally or on any remote,
 * so a number taken on origin is never reused - and steps forward on a
 * collision, because `Git.addWorktree` is atomic: two concurrent Spawns race
 * for the branch and the loser retries rather than clobbering the winner.
 */
export async function nextRunName(
  git: Git,
  agent: Agent,
  slug: string,
  base: string,
  worktreesDir: string,
  maxAttempts = 50
): Promise<RunName> {
  const prefix = branchPrefix(agent.name, slug);
  let counter = maxRunCounter(git.listRunBranches(prefix), prefix) + 1;
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
