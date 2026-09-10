import type { Agent } from '../agent/index.js';
import type { Git } from '../git/index.js';

/** Clean seam for run branch naming and collision resolution. */
export interface BranchNamer {
  /** Generate the next available branch name for a run. */
  nextBranch(
    agent: Agent,
    slug: string,
    maxAttempts?: number
  ): Promise<{ branch: string; counter: number }>;
}

export type RunBranchNamer = BranchNamer;

/** Production branch namer using actual git operations. */
export class ProductionBranchNamer implements BranchNamer {
  constructor(
    private readonly git: Git,
    private readonly worktreesDir = '/tmp/e-worktrees'
  ) {}

  async nextBranch(
    agent: Agent,
    slug: string,
    maxAttempts = 50
  ): Promise<{ branch: string; counter: number }> {
    const prefix = `e/${agent.name}/${slug}`;
    let counter = this.maxRunCounter(prefix) + 1;
    let attempt = 0;

    while (true) {
      const branch = `${prefix}-${counter}`;
      try {
        this.git.addWorktree({
          path: `${this.worktreesDir}/${branch}`,
          branch,
          base: this.git.headSha(),
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

  private maxRunCounter(prefix: string): number {
    const existing = this.git.listRunBranches(prefix);
    const matches = existing.filter(
      (b: string) => b.startsWith(prefix) || b.startsWith(`origin/${prefix}`)
    );
    const counters = matches.map((b: string) => {
      const match = b.match(/-?(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    });
    return Math.max(...counters, 0);
  }
}

/** In-memory branch namer for testing. */
export class InMemoryBranchNamer implements BranchNamer {
  private branches = new Set<string>();
  private base: string;

  constructor(base = 'main') {
    this.base = base;
  }

  async nextBranch(
    agent: Agent,
    slug: string,
    maxAttempts = 50
  ): Promise<{ branch: string; counter: number }> {
    let attempt = 0;
    let counter = 1;

    while (true) {
      const branch = `e/${agent.name}/${slug}-${counter}`;

      if (!this.branches.has(branch)) {
        this.branches.add(branch);
        return { branch, counter };
      }

      if (attempt >= maxAttempts) {
        throw new Error(
          `Could not find unique branch name after ${maxAttempts} attempts`
        );
      }

      counter++;
      attempt++;
    }
  }
}
