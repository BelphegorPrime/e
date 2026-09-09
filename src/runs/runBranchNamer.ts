import type { Agent } from '../agent/index.js';
import type { Git } from '../git/index.js';
import { slugify } from '../identity/slugify.js';

/** Clean seam for run branch naming and collision resolution. */
export interface BranchNamer {
  /** Generate the next available branch name for a run. */
  nextBranch(agent: Agent, prompt: string, maxAttempts?: number): Promise<{ branch: string; counter: number }>;
}

/** Production branch namer using actual git operations. */
export class ProductionBranchNamer implements BranchNamer {
  constructor(private readonly git: Git) {}

  async nextBranch(agent: Agent, prompt: string, maxAttempts = 50): Promise<{ branch: string; counter: number }> {
    const slug = agent.name ?? slugify(prompt);
    const prefix = `e/${agent.name}/${slug}`;
    let counter = await this.maxRunCounter(prefix) + 1;
    let attempt = 0;
    
    while (true) {
      const branch = `${prefix}-${counter}`;
      try {
        await this.git.addWorktree({
          path: `/some/path/${branch}`, // Path will be resolved by caller
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

  private async maxRunCounter(prefix: string): Promise<number> {
    const existing = await this.git.runBranches();
    const matches = existing.filter((b: string) => b.startsWith(prefix));
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
  private counters = new Map<string, number>();

  async nextBranch(agent: Agent, prompt: string, maxAttempts = 50): Promise<{ branch: string; counter: number }> {
    const slug = agent.name ?? slugify(prompt);
    const prefix = `e/${agent.name}/${slug}`;
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const counter = (this.counters.get(prefix) || 0) + 1;
      this.counters.set(prefix, counter);
      const branch = `${prefix}-${counter}`;
      
      if (!this.branches.has(branch)) {
        this.branches.add(branch);
        return { branch, counter };
      }
    }
    
    throw new Error(`Failed to generate unique branch after ${maxAttempts} attempts`);
  }
}