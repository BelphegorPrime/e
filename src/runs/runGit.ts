import type { Git } from './git/index.js';
import type { PullRequest, GitPlatform } from './store/config.js';

/** Clean seam for git operations in runs. */
export interface GitOperations {
  /** Get the current branch name. */
  currentBranch(): Promise<string | undefined>;
  /** Create a worktree for the run. */
  createWorktree(branch: string): Promise<void>;
  /** Remove a worktree. */
  removeWorktree(branch: string): Promise<void>;
  /** Commit changes from a worktree. */
  commitChanges(branch: string, message: string): Promise<void>;
  /** Push a branch to origin. */
  pushBranch(branch: string): Promise<void>;
  /** Get log entries for a branch. */
  branchLog(branch: string): Promise<Array<{ subject: string }>>;
}

/** Implementation wrapping the Git type. */
export class GitOperationsImpl implements GitOperations {
  constructor(private readonly git: Git) {}

  async currentBranch(): Promise<string | undefined> {
    return this.git.currentBranch();
  }

  async createWorktree(branch: string): Promise<void> {
    await this.git.createWorktree(branch);
  }

  async removeWorktree(branch: string): Promise<void> {
    await this.git.removeWorktree(branch);
  }

  async commitChanges(branch: string, message: string): Promise<void> {
    await this.git.commit(branch, message);
  }

  async pushBranch(branch: string): Promise<void> {
    await this.git.push(branch);
  }

  async branchLog(branch: string): Promise<Array<{ subject: string }>> {
    return this.git.log(branch);
  }
}

/** In-memory git operations for testing. */
export class InMemoryGitOperations implements GitOperations {
  private commits = new Map<string, Array<{ subject: string }>>();
  private branches = new Set<string>();
  private currentB: string | undefined;

  async currentBranch(): Promise<string | undefined> {
    return this.currentB;
  }

  async createWorktree(branch: string): Promise<void> {
    this.branches.add(branch);
    this.currentB = branch;
  }

  async removeWorktree(branch: string): Promise<void> {
    this.branches.delete(branch);
  }

  async commitChanges(branch: string, message: string): Promise<void> {
    const commits = this.commits.get(branch) || [];
    commits.push({ subject: message });
    this.commits.set(branch, commits);
  }

  async pushBranch(branch: string): Promise<void> {
    // Simulate push
  }

  async branchLog(branch: string): Promise<Array<{ subject: string }>> {
    return this.commits.get(branch) || [];
  }
}

/** PR/MR management abstraction. */
export interface PullRequestManager {
  createPullRequest(params: {
    platform: GitPlatform;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<string>;
}

/** Run branch name generator with collision-safe counter logic. */
export class RunBranchNamer {
  constructor(private readonly git: Git) {}

  async nextBranch(
    agent: string,
    slug: string,
    baseBranch: string
  ): Promise<{ branch: string; counter: number }> {
    const existing = await this.git.runBranches();
    const pattern = `e/${agent}/${slug}-`;
    const matches = existing.filter((b: string) => b.startsWith(pattern));
    const counters = matches.map((b: string) => {
      const match = b.match(/-?(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    });
    const nextCounter = Math.max(...counters, 0) + 1;
    return {
      branch: `e/${agent}/${slug}-${nextCounter}`,
      counter: nextCounter,
    };
  }
}