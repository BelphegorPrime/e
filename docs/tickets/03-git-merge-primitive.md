# 03 - Host Git merge primitive

**Shipped 2026-09-12.** `Git.merge(worktreePath, branch, message?)` in
`src/git/index.ts`, implemented by `HostGit` (`src/git/host.ts`) as
`git -C <worktree> merge --no-ff --no-edit [-m <message>] <branch>`. Two
deliberate deviations from the sketch below: the method takes the worktree
path like every other worktree-scoped call (`isDirty`, `commitAll`), and it
returns a `MergeOutcome` instead of `void` - `merged`, `up-to-date`, or
`conflict` with the conflicted paths - because a conflict is an expected
outcome of merge-back (ADR-0013), not an error, and the caller (ticket 07)
must tell the agent which files to clear. On conflict the merge is left in
progress (`MERGE_HEAD` set, markers in the files), never auto-resolved and
never aborted; the agent concludes it the normal way. `HostGit.merge` throws
when git refuses to start - unknown ref, a merge already in progress
(checked up front, so a stale conflict is never reported under the new
branch's name), local changes in the way - leaving the worktree untouched,
and when the merge stopped without a conflict (a failing `pre-merge-commit`
hook leaves it staged). `--no-ff` keeps a sibling's work as one visible merge
node in the parent's history; it also makes git refuse on any _staged_
change, not only one the merge would overwrite, so ticket 07's checkpoint
must be the last index write before a merge-back. Conflicted paths are read
with `-z`, so a non-ASCII name comes back verbatim. An untracked file that a
merge would overwrite is a refusal whose paths live only in git's message;
07 may need to parse them or move the file aside first. (Ticket 07 did: a
refusal over local or untracked changes in the way is now a fourth outcome,
`{ status: 'refused', files }`, parsed from git's message; other refusals
still throw. `Git.mergeInProgress(worktreePath)` was added alongside.) The in-memory doubles are
the scripted `Git` fakes next to their tests (`runSpawn.test.ts` scripts an
outcome per branch and records every call; `executeSpawn.test.ts` and
`serve.test.ts` merge cleanly).

**What to build:** `Git.merge(branch)` added to `src/git/index.ts`, implemented in `HostGit` (`src/git/host.ts`), and mirrored in the in-memory test double. Merges a branch into the worktree's current branch; surfaces conflict markers rather than aborting silently.

**Blocked by:** None - can start immediately.

**Status:** done

- [x] `Git` interface exposes `merge(branch: string): void` (as `merge(worktreePath, branch, message?): MergeOutcome`, see above)
- [x] `HostGit.merge` performs a git merge; conflicts leave markers in the worktree (no auto-resolve)
- [x] In-memory double mirrors the contract for tests
- [x] Unit tests cover clean merge and conflict case
