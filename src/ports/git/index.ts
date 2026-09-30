/**
 * Host-side git operations a Run needs. Mirrors the `ContainerRuntime`
 * abstraction: the orchestrator (`runSpawn`) depends only on this interface,
 * so it can be driven by a fake in tests, and all real git - including the
 * push credentials it implies - stays in the host process (ADR-0002).
 */
export interface Git {
  /** True if `cwd` is inside a git repository. */
  isRepo(): boolean;

  /**
   * The absolute path of the repository's top-level directory
   * (`rev-parse --show-toplevel`); undefined outside a repository.
   */
  toplevel(): string | undefined;

  /**
   * The commit SHA `HEAD` points at: the host repo's, or - given a path - the
   * worktree's there (a run branch's tip, e.g. after a checkpoint).
   */
  headSha(worktreePath?: string): string;

  /** The short name of the branch `HEAD` is currently on, or '' when detached. */
  currentBranch(): string;

  /**
   * The commit a full ref name (`refs/heads/main`) points at, peeled through
   * tags; undefined when it does not resolve. Asks about refs only: whether a
   * name is one the caller may use is the caller's rule, not git's.
   */
  resolveCommit(ref: string): string | undefined;

  /**
   * The text of the host file at `filePath` as committed at `ref`
   * (`git show <ref>:<path>`), never as the working tree has it; undefined
   * when the file is not in that commit. `filePath` is a host path inside
   * this repository.
   */
  readFileAt(ref: string, filePath: string): string | undefined;

  /**
   * Writes the directory at host path `dirPath` as committed at `ref` into
   * `dest` (created if missing), which receives its contents: `a/b` under
   * `dirPath` lands at `<dest>/a/b`. Never reads the working tree. A file
   * keeps its executable bit, a symlink is written as a symlink with its
   * target verbatim - where one leads is the caller's to judge - and a
   * submodule is skipped. Throws when `dirPath` is not a directory in that
   * commit.
   */
  exportTree(ref: string, dirPath: string, dest: string): void;

  /**
   * The repository's default branch as a full remote-tracking ref
   * (`refs/remotes/origin/main`): `origin/HEAD` when it is set, else what
   * origin itself reports - `actions/checkout` never sets `origin/HEAD`, and
   * that fallback asks origin over the network (`ls-remote`). Undefined
   * without an origin to ask, or when it does not answer.
   */
  defaultBranchRef(): string | undefined;

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

  /**
   * Create a worktree at `path`, checking out a new `branch` from `base`.
   * Atomic: fails (throws) if the branch or the path already exists, so two
   * concurrent Spawns can never clobber each other's branch.
   */
  addWorktree(spec: WorktreeSpec): void;

  /**
   * Create a worktree at `path` checking out the **existing** `branch` - a
   * resumed Run's own (ADR-0017), never a new one. A branch that exists only
   * on origin is checked out as a new local branch tracking it (git's
   * `worktree add` guess). Throws when no such branch exists, when it is
   * checked out in another worktree, or when `path` is not empty.
   */
  checkoutWorktree(worktreePath: string, branch: string): void;

  /** True if the worktree at `path` has uncommitted changes (tracked or untracked). */
  isDirty(worktreePath: string): boolean;

  /** Stage everything (`add -A`) and commit it on the worktree's branch. */
  commitAll(worktreePath: string, message: string): void;

  /** True if `branch` has any commits not reachable from `base`. */
  hasCommitsBeyondBase(branch: string, base: string): boolean;

  /**
   * Per-file added/removed line counts of `base..tip`, limited to
   * `pathspecs` (git evaluates them; `git diff --numstat`). Rename detection
   * is git's default and stays on: a rename inside the pathspecs is one entry
   * with its `from`, while one leaving them reads as a removal of the source.
   * `pathspecs` must not be empty - that would be every file.
   */
  numstat(base: string, tip: string, pathspecs: string[]): NumstatEntry[];

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
   * conflicted paths are reported for the caller to hand to the agent. So is
   * a refusal over local changes in the way (an uncommitted or untracked file
   * the merge would overwrite; with `--no-ff` any *staged* change counts):
   * the worktree is untouched and the paths git named are reported, for the
   * caller to have cleared before it retries. Throws when git refuses for any
   * other reason - an unknown ref, a merge already in progress - leaving the
   * worktree untouched; and when the merge stopped without a conflict (a
   * failing `pre-merge-commit` hook leaves it staged with `MERGE_HEAD` set).
   */
  merge(worktreePath: string, branch: string, message?: string): MergeOutcome;

  /**
   * True while a merge is in progress in the worktree at `worktreePath`
   * (`MERGE_HEAD` resolves): a conflict nobody has concluded yet. The next
   * `commitAll` there concludes it as the merge commit.
   */
  mergeInProgress(worktreePath: string): boolean;

  /**
   * Abandon the merge in progress in the worktree at `worktreePath`
   * (`merge --abort`): the index and the merged-in files go back to the
   * pre-merge commit, `MERGE_HEAD` is cleared, and edits to files the merge
   * never touched are kept. Throws when git refuses - a file the merge brought
   * in has been edited since - leaving the merge in progress and every file
   * as it was.
   */
  abortMerge(worktreePath: string): void;
}

/** One file of a {@link Git.numstat}. */
export interface NumstatEntry {
  /** The path at `tip` (for a rename, the destination). */
  path: string;
  /** The path at `base`, for a rename. */
  from?: string;
  /** Lines added; `null` for a binary file, which git does not count. */
  added: number | null;
  /** Lines removed; `null` for a binary file. */
  removed: number | null;
}

/** How a {@link Git.merge} ended. */
export type MergeOutcome =
  /** A merge commit landed on the worktree's branch. */
  | { status: 'merged' }
  /** `branch` was already reachable; nothing changed. */
  | { status: 'up-to-date' }
  /** Left in progress: markers in `files`, `MERGE_HEAD` set, for the agent to resolve. */
  | { status: 'conflict'; files: string[] }
  /** Not started: local changes to `files` (as git named them) would be overwritten; the worktree is untouched. */
  | { status: 'refused'; files: string[] };

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
