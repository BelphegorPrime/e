/**
 * **The in-memory `Git` adapter.** The second adapter at the `Git` seam: the
 * host one shells out, this one keeps branches, tips and worktrees as data and
 * behaves the way git does. Tests drive the whole Run lifecycle through it -
 * checkpoint, branch, commit, push, Merge-back - without a repository on disk.
 *
 * It replaces five hand-written doubles that each re-stubbed all of `Git` and
 * had each learned the contract its own way. Two rules keep this one honest:
 *
 *  - **Behaviour is real where the answer is in the data.** `addWorktree`
 *    creates a branch and refuses one that exists, `commitAll` advances that
 *    worktree's tip and clears its dirt, `listRunBranches` filters what is
 *    actually there. A test that wants a collision creates the branch first.
 *  - **Only the outside world is scripted.** Whether a worktree has
 *    uncommitted changes, how a merge ends, and which calls fail are facts no
 *    in-memory model can derive, so they are options.
 *
 * Everything a caller did is recorded, so a test can assert on the calls as
 * well as on the resulting state.
 */

import type {
  Git,
  MergeOutcome,
  RunCommit,
  RunRef,
  WorktreeSpec,
} from './index.js';

/** A merge answer: an outcome, or an `Error` the call throws. */
export type ScriptedMerge = MergeOutcome | Error;

export interface InMemoryGitOptions {
  /** False models a directory outside a git repository. */
  repo?: boolean;
  /** The sha `headSha()` reports for the host repo; run branches are cut from it. */
  headSha?: string;
  /** The branch `currentBranch()` reports (`''` for a detached HEAD). */
  currentBranch?: string;
  /** Branches that already exist, by name. Use {@link refs} when the test needs their tip metadata. */
  branches?: string[];
  /** Branches that already exist, with their tips - the raw material of the runs index. */
  refs?: RunRef[];
  /**
   * Commits per branch, newest first, as `runLog` returns them. A bare array
   * is the log of every branch that has none of its own, for a test that
   * cares about the tip but not about which branch it is on.
   */
  log?: RunCommit[] | Record<string, RunCommit[]>;
  /**
   * Tips of worktrees this adapter did not create - a parent worktree that
   * was already on disk when the run started. `headSha(path)` answers these.
   */
  worktreeHeads?: Record<string, string>;
  /**
   * Uncommitted changes: a flag for every worktree, or per path. `commitAll`
   * clears the path it committed, so a checkpoint test needs no bookkeeping.
   */
  dirty?: boolean | Record<string, boolean>;
  /**
   * Whether a run branch carries work beyond its base. Scripted rather than
   * derived: a real run branch has the run's commit on it by the time this is
   * asked, and nothing in memory models the container that produced it.
   * Defaults to `true`; set it false for the "nothing to push" case.
   */
  hasCommitsBeyondBase?: boolean;
  /**
   * Worktree paths where a merge is already in progress when the adapter is
   * built - a conflict nobody has concluded yet, from a call the test did not
   * make. `true` applies to every path. A conflict this adapter itself
   * returns sets the flag without the option.
   */
  merging?: boolean | string[];
  /**
   * Merge answers per branch. An array is consumed one call at a time and its
   * last entry repeats, so a conflict that clears on retry is
   * `[{status:'conflict',files:[...]}, {status:'merged'}]`.
   */
  merge?: Record<string, ScriptedMerge | ScriptedMerge[]>;
  /** Messages that make a call throw instead of doing its work. */
  fail?: Partial<
    Record<'addWorktree' | 'commitAll' | 'push' | 'listRunRefs', string>
  >;
  /**
   * Branches whose `addWorktree` reports a collision **without** being visible
   * to `listRunBranches` - the race the retry exists for: another Spawn
   * created the branch after this one scanned the counter. Listing them would
   * defeat the point, because the counter would simply skip past them.
   */
  collide?: string[];
}

export class InMemoryGit implements Git {
  /** Method names in call order. */
  readonly calls: string[] = [];
  /** Prefixes passed to `listRunBranches`, in order. */
  readonly listedPrefixes: string[] = [];
  /** Worktrees created, in order. */
  readonly worktrees: WorktreeSpec[] = [];
  /** Worktree paths removed, in order. */
  readonly removedWorktrees: string[] = [];
  /** Commits made, in order. */
  readonly commits: { path: string; message: string }[] = [];
  /** Branches pushed, in order. */
  readonly pushed: string[] = [];
  /** Merges attempted, in order. */
  readonly merges: {
    worktreePath: string;
    branch: string;
    message?: string;
  }[] = [];

  /** Branch name to tip sha, for every branch that exists. */
  private readonly branches = new Map<string, string>();
  /** Worktree path to the branch checked out there. */
  private readonly checkouts = new Map<string, string>();
  private readonly dirtyPaths = new Map<string, boolean>();
  private readonly logs: Record<string, RunCommit[]>;
  /** The log of any branch without one of its own (see {@link InMemoryGitOptions.log}). */
  private readonly defaultLog: RunCommit[];
  private readonly worktreeHeads: Record<string, string>;
  private defaultDirty: boolean;
  private readonly merging = new Set<string>();
  /** Branches that collide on create but are invisible to a counter scan (see {@link InMemoryGitOptions.collide}). */
  private readonly collide: Set<string>;
  /** Worktrees whose pre-set `merging: true` a commit has since concluded. */
  private readonly concluded = new Set<string>();
  private mergeScript: Record<string, ScriptedMerge[]>;
  private refs: RunRef[];
  private commitCounter = 0;

  constructor(private readonly opts: InMemoryGitOptions = {}) {
    this.refs = [...(opts.refs ?? [])];
    this.logs = Array.isArray(opts.log) ? {} : { ...(opts.log ?? {}) };
    this.defaultLog = Array.isArray(opts.log) ? opts.log : [];
    this.worktreeHeads = { ...(opts.worktreeHeads ?? {}) };
    this.defaultDirty = typeof opts.dirty === 'boolean' ? opts.dirty : false;
    for (const name of opts.branches ?? [])
      this.branches.set(name, `${name}-tip`);
    for (const ref of this.refs) this.branches.set(ref.name, ref.sha);
    this.collide = new Set(opts.collide ?? []);
    if (Array.isArray(opts.merging)) {
      for (const path of opts.merging) this.merging.add(path);
    }
    if (typeof opts.dirty === 'object') {
      for (const [path, value] of Object.entries(opts.dirty)) {
        this.dirtyPaths.set(path, value);
      }
    }
    this.mergeScript = Object.fromEntries(
      Object.entries(opts.merge ?? {}).map(([branch, answer]) => [
        branch,
        Array.isArray(answer) ? [...answer] : [answer],
      ])
    );
  }

  isRepo(): boolean {
    this.calls.push('isRepo');
    return this.opts.repo ?? true;
  }

  headSha(worktreePath?: string): string {
    this.calls.push('headSha');
    const base = this.opts.headSha ?? 'basesha';
    if (worktreePath === undefined) return base;
    const branch = this.checkouts.get(worktreePath);
    if (branch) return this.branches.get(branch) ?? base;
    return this.worktreeHeads[worktreePath] ?? base;
  }

  currentBranch(): string {
    this.calls.push('currentBranch');
    return this.opts.currentBranch ?? 'main';
  }

  listRunBranches(prefix: string): string[] {
    this.calls.push('listRunBranches');
    this.listedPrefixes.push(prefix);
    // The real one globs `refs/heads/<prefix>-*` and `refs/remotes/*/<prefix>-*`.
    return [...this.branches.keys()].filter(
      name => name.includes(`${prefix}-`) || name.startsWith(`${prefix}/`)
    );
  }

  listRunRefs(prefix: string): RunRef[] {
    this.calls.push('listRunRefs');
    if (this.opts.fail?.listRunRefs) {
      throw new Error(this.opts.fail.listRunRefs);
    }
    return this.refs.filter(
      ref => ref.name.includes(`${prefix}-`) || ref.name.includes(`${prefix}/`)
    );
  }

  runLog(branch: string): RunCommit[] {
    this.calls.push('runLog');
    return this.logs[branch] ?? this.defaultLog;
  }

  /**
   * Re-scripts what the next `merge` of `branch` answers. For a test that
   * changes the world mid-run - the agent resolves the conflict, the retry
   * lands - where the array form of {@link InMemoryGitOptions.merge} would
   * decide the timing instead of the test.
   */
  setMerge(branch: string, answer: ScriptedMerge | ScriptedMerge[]): void {
    this.mergeScript[branch] = Array.isArray(answer) ? [...answer] : [answer];
  }

  addWorktree(spec: WorktreeSpec): void {
    this.calls.push('addWorktree');
    if (this.opts.fail?.addWorktree) {
      throw new Error(this.opts.fail.addWorktree);
    }
    // Atomic, like the real one: the branch or the path already being there is
    // how two concurrent Spawns discover they raced.
    if (this.branches.has(spec.branch) || this.collide.has(spec.branch)) {
      throw new Error(`fatal: a branch named '${spec.branch}' already exists`);
    }
    if (this.checkouts.has(spec.path)) {
      throw new Error(`fatal: '${spec.path}' already exists`);
    }
    const tip = this.branches.get(spec.base) ?? spec.base;
    this.branches.set(spec.branch, tip);
    this.checkouts.set(spec.path, spec.branch);
    this.worktrees.push(spec);
  }

  isDirty(worktreePath: string): boolean {
    this.calls.push('isDirty');
    const explicit = this.dirtyPaths.get(worktreePath);
    if (explicit !== undefined) return explicit;
    return this.defaultDirty;
  }

  /**
   * Makes a worktree dirty or clean from outside, for a test where the world
   * changes mid-run - the parent's agent writes while a sibling is merging.
   * Without a path it is the default for every worktree.
   */
  setDirty(dirty: boolean, worktreePath?: string): void {
    if (worktreePath === undefined) {
      this.defaultDirty = dirty;
      this.dirtyPaths.clear();
      return;
    }
    this.dirtyPaths.set(worktreePath, dirty);
  }

  commitAll(worktreePath: string, message: string): void {
    this.calls.push('commitAll');
    if (this.opts.fail?.commitAll) throw new Error(this.opts.fail.commitAll);
    this.commits.push({ path: worktreePath, message });
    const sha = `commit-${++this.commitCounter}`;
    const branch = this.checkouts.get(worktreePath);
    if (branch) {
      this.branches.set(branch, sha);
      (this.logs[branch] ??= [...this.defaultLog]).unshift({
        sha,
        subject: message,
        committerDate: '2026-01-01T00:00:00+00:00',
      });
    }
    // A commit moves that worktree's HEAD whether or not this adapter created
    // it: a parent worktree the run was handed is checkpointed the same way.
    this.worktreeHeads[worktreePath] = sha;
    this.dirtyPaths.set(worktreePath, false);
    // A commit with MERGE_HEAD set is the merge commit: it concludes it.
    this.merging.delete(worktreePath);
    this.concluded.add(worktreePath);
  }

  hasCommitsBeyondBase(_branch: string, _base: string): boolean {
    this.calls.push('hasCommitsBeyondBase');
    return this.opts.hasCommitsBeyondBase ?? true;
  }

  push(branch: string): void {
    this.calls.push('push');
    if (this.opts.fail?.push) throw new Error(this.opts.fail.push);
    this.pushed.push(branch);
    const sha = this.branches.get(branch);
    if (sha && !this.refs.some(ref => ref.name === `origin/${branch}`)) {
      this.refs.push({
        name: `origin/${branch}`,
        sha,
        committerDate: '2026-01-01T00:00:00+00:00',
        subject: this.logs[branch]?.[0]?.subject ?? '',
      });
    }
  }

  removeWorktree(worktreePath: string): void {
    this.calls.push('removeWorktree');
    this.removedWorktrees.push(worktreePath);
    this.checkouts.delete(worktreePath);
  }

  merge(worktreePath: string, branch: string, message?: string): MergeOutcome {
    this.calls.push('merge');
    this.merges.push({ worktreePath, branch, message });
    const queued = this.mergeScript[branch];
    const answer =
      queued === undefined
        ? undefined
        : queued.length > 1
          ? queued.shift()
          : queued[0];
    if (answer instanceof Error) throw answer;
    const outcome: MergeOutcome = answer ?? { status: 'merged' };
    // A conflict is left in progress with the markers in place; only the next
    // `commitAll` there concludes it.
    if (outcome.status === 'conflict') this.merging.add(worktreePath);
    return outcome;
  }

  mergeInProgress(worktreePath: string): boolean {
    this.calls.push('mergeInProgress');
    if (this.opts.merging === true && !this.concluded.has(worktreePath)) {
      return true;
    }
    return this.merging.has(worktreePath);
  }
}
