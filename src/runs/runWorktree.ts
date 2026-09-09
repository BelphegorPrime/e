import type { Git } from '../git/index.js';

/** Clean seam for worktree management in runs. */
export interface WorktreeManager {
  /** Create a worktree with collision-safe naming. */
  createWorktree(
    path: string,
    branch: string,
    base: string,
    maxAttempts?: number
  ): Promise<void>;
  /** Remove a worktree. */
  removeWorktree(path: string): Promise<void>;
}

/** Production worktree manager using actual git operations. */
export class ProductionWorktreeManager implements WorktreeManager {
  constructor(private readonly git: Git) {}

  async createWorktree(
    path: string,
    branch: string,
    base: string,
    maxAttempts = 50
  ): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        await this.git.addWorktree({ path, branch, base });
        return;
      } catch (err) {
        const isCollision = /already exists/i.test((err as Error).message);
        if (!isCollision || attempt >= maxAttempts) {
          throw err;
        }
        attempt++;
      }
    }
  }

  async removeWorktree(path: string): Promise<void> {
    await this.git.removeWorktree(path);
  }
}

/** In-memory worktree manager for testing. */
export class InMemoryWorktreeManager implements WorktreeManager {
  private worktrees: Map<string, { branch: string; base: string }> = new Map();

  async createWorktree(
    path: string,
    branch: string,
    base: string
  ): Promise<void> {
    if (this.worktrees.has(path)) {
      const error = new Error('already exists');
      error.message = 'already exists';
      throw error;
    }
    this.worktrees.set(path, { branch, base });
  }

  async removeWorktree(path: string): Promise<void> {
    this.worktrees.delete(path);
  }
}
