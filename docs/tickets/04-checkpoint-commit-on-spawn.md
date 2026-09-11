# 04 - Checkpoint commit on spawn

**What to build:** At every spawn request, the host runs `git commitAll` on the parent worktree path before the child's worktree branches from that commit. This closes the ADR-0001 gap where worktrees only carry committed state. Verified end to end: dirty parent worktree becomes clean; child worktree contains parent's WIP snapshot.

**Blocked by:** None - can start immediately.

**Status:** ready-for-agent

- [ ] `runSpawn` checkpoints parent worktree (calls `Git.commitAll` on its path) before creating child worktree
- [ ] Dirty worktree → clean checkpoint commit happens automatically (no agent action)
- [ ] Child worktree branches from checkpoint commit, so parent WIP is visible inside child
- [ ] Test covers: pre-spawn dirty state, post-spawn clean state, child worktree contains changes
