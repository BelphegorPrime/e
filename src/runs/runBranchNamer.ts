import type { Agent } from '../agent/index.js';
import type { Git } from '../git/index.js';
import { defaultWorktreesDir, worktreePathFor } from './worktreesDir.js';

/** Clean seam for run branch naming and collision resolution. */
export interface BranchNamer {
  /** Cut the next available run branch from `base`, creating its worktree. */
  nextBranch(
    agent: Agent,
    slug: string,
    base: string,
    maxAttempts?: number
  ): Promise<{ branch: string; counter: number }>;
}

/** Production branch namer using actual git operations. */
export class ProductionBranchNamer implements BranchNamer {
  constructor(
    private readonly git: Git,
    private readonly worktreesDir: string = defaultWorktreesDir()
  ) {}

  async nextBranch(
    agent: Agent,
    slug: string,
    base: string,
    maxAttempts = 50
  ): Promise<{ branch: string; counter: number }> {
    const prefix = `e/${agent.name}/${slug}`;
    let counter = this.maxRunCounter(prefix) + 1;
    let attempt = 0;

    while (true) {
      const branch = `${prefix}-${counter}`;
      try {
        this.git.addWorktree({
          path: worktreePathFor(this.worktreesDir, branch),
          branch,
          base,
        });
        return { branch, counter };
      } catch (err) {
        const isCollision = /already exists/i.test((err as Error).message);
        if (!isCollision || attempt >= maxAttempts) {
          throw err;
        }
        counter++;
        attempt++;
      }
    }
  }

  /**
   * The highest counter already used for exactly this `<prefix>-<n>` branch,
   * locally or on any remote (`<remote>/<prefix>-<n>`). Sibling slugs that
   * merely start with the prefix (`fix` vs `fix-typo-3`) do not count.
   */
  private maxRunCounter(prefix: string): number {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const runBranch = new RegExp(`^(?:[^/]+/)?${escaped}-(\\d+)$`);
    let max = 0;
    for (const branch of this.git.listRunBranches(prefix)) {
      const match = runBranch.exec(branch);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
    return max;
  }
}
