# 03 - Host Git merge primitive

**What to build:** `Git.merge(branch)` added to `src/git/index.ts`, implemented in `HostGit` (`src/git/host.ts`), and mirrored in the in-memory test double. Merges a branch into the worktree's current branch; surfaces conflict markers rather than aborting silently.

**Blocked by:** None - can start immediately.

**Status:** ready-for-agent

- [ ] `Git` interface exposes `merge(branch: string): void`
- [ ] `HostGit.merge` performs a git merge; conflicts leave markers in the worktree (no auto-resolve)
- [ ] In-memory double mirrors the contract for tests
- [ ] Unit tests cover clean merge and conflict case
