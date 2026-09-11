# 07 - Merge-back flow

**What to build:** After a child run exits, the host merges the child's branch into the parent branch using `Git.merge` (#3). If the parent has overlapping dirty edits, host folds parent's current WIP into the merge commit and updates the worktree in place; remaining in-flight overlap → merge held pending, parent told to clear files, host retries on signal. Child delivered via merged files in worktree + report at `e-runs/<child>/report.md`.

**Blocked by:** 03 - Host Git merge primitive; 04 - Checkpoint commit on spawn.

**Status:** blocked

- [ ] On child exit, host merges child branch into parent branch (merge commit)
- [ ] Overlapping parent edits folded into merge commit; worktree updated in place
- [ ] In-flight overlap → merge held pending; parent receives clear-files instruction; host retries after signal
- [ ] Report written at `e-runs/<child>/report.md` for parent agent consumption
- [ ] Merge conflict markers never silently auto-resolved
- [ ] Tests cover clean merge, WIP-fold, hold-pending path, report written
