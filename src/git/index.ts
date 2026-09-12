/**
 * Host-side git operations a Run needs. Mirrors the `ContainerRuntime`
 * abstraction: the orchestrator (`runSpawn`) depends only on this interface,
 * so it can be driven by a fake in tests, and all real git - including the
 * push credentials it implies - stays in the host process (ADR-0002).
 */
export interface Git {
  /** True if `cwd` is inside a git repository. */
  isRepo(): boolean;

  /** The commit SHA that `HEAD` currently points at. */
  headSha(): string;

  /** The short name of the branch `HEAD` is currently on, or '' when detached. */
  currentBranch(): string;

  /**
   * Shortnames of existing run branches matching `<prefix>-*`, across both
   * local heads and remote-tracking refs, so the run counter never reuses a
   * number already taken locally or on origin.
   */
  listRunBranches(prefix: string): string[];

  /**
   * Tip metadata for every branch under `refs/heads/<prefix>-*` or nested
   * under `refs/heads/<prefix>/` (and the remote-tracking twins) - the raw
   * material of the branch-backed runs index (ADR-0010). Both shapes are
   * enumerated so a full prefix (`e/<agent>/<slug>`) and the namespace
   * prefix (`e`) work; newest commit first.
   */
  listRunRefs(prefix: string): RunRef[];

  /**
   * A branch's commits, newest first. `branch` is any ref git understands,
   * including a remote-tracking short name like `origin/e/<agent>/<slug>-N`.
   */
  runLog(branch: string): RunCommit[];

  /** True if `branch` (a local or remote-tracking ref) resolves to a commit. */
  branchExists(branch: string): boolean;

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

  /**
   * Merge `branch` into the branch the worktree at `worktreePath` has checked
   * out, always as a merge commit (`--no-ff`) so a sibling's work stays
   * visible in the parent's history (ADR-0013). A conflict is an expected
   * outcome, not an error: the merge is left in progress with the markers in
   * the worktree files (never auto-resolved, never aborted) and the
   * conflicted paths are reported for the caller to hand to the agent. Throws
   * when git refuses to start the merge - an unknown ref, a merge already in
   * progress, or local changes in the way (with `--no-ff` any *staged* change
   * counts, not only one the merge would overwrite) - in which case the
   * worktree is untouched; and when the merge stopped without a conflict (a
   * failing `pre-merge-commit` hook leaves it staged with `MERGE_HEAD` set).
   */
  merge(worktreePath: string, branch: string, message?: string): MergeOutcome;
}

/** How a {@link Git.merge} ended. */
export type MergeOutcome =
  /** A merge commit landed on the worktree's branch. */
  | { status: 'merged' }
  /** `branch` was already reachable; nothing changed. */
  | { status: 'up-to-date' }
  /** Left in progress: markers in `files`, `MERGE_HEAD` set, for the agent to resolve. */
  | { status: 'conflict'; files: string[] };

/** A run branch's current tip, as enumerated by `for-each-ref`. */
export interface RunRef {
  /** Short name: `e/<agent>/<slug>-N` (local) or `<remote>/e/<agent>/<slug>-N`. */
  name: string;
  sha: string;
  /** ISO-8601 committer timestamp (`%(committerdate:iso-strict)`). */
  committerDate: string;
  subject: string;
}

/** One commit on a run branch, newest first (`git log`). */
export interface RunCommit {
  sha: string;
  subject: string;
  committerDate: string;
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
