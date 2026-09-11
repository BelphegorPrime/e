import type { Git } from '../git/index.js';

/**
 * Clean seam for worktree teardown in runs. Creation lives in the branch
 * namer: the branch name and the worktree are created atomically there.
 */
export interface WorktreeManager {
  /** Remove a worktree. */
  removeWorktree(path: string): Promise<void>;
}

/** Production worktree manager using actual git operations. */
export class ProductionWorktreeManager implements WorktreeManager {
  constructor(private readonly git: Git) {}

  async removeWorktree(path: string): Promise<void> {
    await this.git.removeWorktree(path);
  }
}
