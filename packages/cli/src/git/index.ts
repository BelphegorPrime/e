/**
 * Host-side git operations a Run needs. Mirrors the `ContainerRuntime`
 * abstraction: the orchestrator (`runSpawn`) depends only on this interface,
 * so it can be driven by a fake in tests, and all real git — including the
 * push credentials it implies — stays in the host process (ADR-0002).
 */
export interface Git {
  /** True if `cwd` is inside a git repository. */
  isRepo(): boolean;

  /** The commit SHA that `HEAD` currently points at. */
  headSha(): string;

  /**
   * Shortnames of existing run branches matching `<prefix>-*`, across both
   * local heads and remote-tracking refs, so the run counter never reuses a
   * number already taken locally or on origin.
   */
  listRunBranches(prefix: string): string[];

  /**
   * Create a worktree at `path`, checking out a new `branch` from `base`.
   * Atomic: fails (throws) if the branch or the path already exists, so two
   * concurrent Spawns can never clobber each other's branch.
   */
  addWorktree(spec: WorktreeSpec): void;

  /** True if the worktree at `path` has uncommitted changes (tracked or untracked). */
  isDirty(worktreePath: string): boolean;

  /** Stage everything (`add -A`) and commit it on the worktree's branch. */
  commitAll(worktreePath: string, message: string): void;

  /** True if `branch` has any commits not reachable from `base`. */
  hasCommitsBeyondBase(branch: string, base: string): boolean;

  /** Push `branch` to origin. Throws on any failure (no remote, auth, reject). */
  push(branch: string): void;

  /** Remove the worktree at `path`, keeping its branch. */
  removeWorktree(worktreePath: string): void;
}

/** Where and how a Run's worktree is checked out. */
export interface WorktreeSpec {
  /** Host filesystem path the worktree is created at. */
  path: string;
  /** New branch the worktree checks out, e.g. `e/claudeCode/fix-the-bug`. */
  branch: string;
  /** Ref the branch is cut from, typically `HEAD`. */
  base: string;
}
