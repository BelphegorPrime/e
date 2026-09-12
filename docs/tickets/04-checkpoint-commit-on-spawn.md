# 04 - Checkpoint commit on spawn

**Shipped 2026-09-12.** `runSpawn` takes an optional `parent`
(`{ worktreePath, branch }`, `src/runs/runSpawn.ts`). When present, the run
is a sibling: before its branch is cut, the host commits whatever is
uncommitted in the parent worktree on the parent's own branch
(`Git.commitAll`, message `e: checkpoint <parentBranch> before spawning
<slug>`; a clean parent gets no commit), then the sibling branches from that
tip (`Git.headSha(worktreePath)`, a new optional parameter on the existing
method) instead of the host's HEAD (`BranchNamer.nextBranch` now takes the base
explicitly). `RunSpawnResult.base` reports the commit a run branched from. A
checkpoint whose commit fails (a permanently failing hook) fails the request
with the reason before anything of the sibling exists; the parent keeps its
work, staged by the attempt. Accepted like the run-end capture: `add -A`
sweeps every non-ignored file, so a target repo that does not ignore `.env`
gets it committed on the parent branch; and the parent agent keeps writing
while the host commits, so a half-written file can land in a checkpoint - the
sibling sees a slightly earlier state, merge-back (07) reconciles. Open for
ticket 06: whether a sibling opens a PR at all (its PR base is still the
host's current branch, unchanged here). Nothing in the CLI sets `parent` yet: the host
side that consumes sibling requests (ticket 06) will. Verified end to end
against real git in `runSpawn.checkpoint.test.ts` (dirty parent becomes
clean, one host commit, the sibling's worktree holds the WIP), and with the
scripted fakes in `runSpawn.test.ts` (order: checkpoint before worktree; a
clean parent is not committed). The container-runtime fake moved to
`runSpawn.testSupport.ts` so both tests share it.

**What to build:** At every spawn request, the host runs `git commitAll` on the parent worktree path before the child's worktree branches from that commit. This closes the ADR-0001 gap where worktrees only carry committed state. Verified end to end: dirty parent worktree becomes clean; child worktree contains parent's WIP snapshot.

**Blocked by:** None - can start immediately.

**Status:** done

- [x] `runSpawn` checkpoints parent worktree (calls `Git.commitAll` on its path) before creating child worktree
- [x] Dirty worktree → clean checkpoint commit happens automatically (no agent action)
- [x] Child worktree branches from checkpoint commit, so parent WIP is visible inside child
- [x] Test covers: pre-spawn dirty state, post-spawn clean state, child worktree contains changes
