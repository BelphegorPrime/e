# 15 - Auto-push successful run branches to origin

**Status:** Done (closed 2026-08-07).

**GitHub:** [#4](https://github.com/BelphegorPrime/e/issues/4)

---

## Parent

BelphegorPrime/e#1

## What to build

Auto-publish successful runs. After the worktree work is committed, determine whether the run branch has commits beyond its base ref. If the agent exited 0 **and** there are commits, push the branch to origin; otherwise keep it local (aborted or no-op runs never reach origin). A push failure — no remote, auth failure, rejected push — is non-fatal: the branch is preserved locally and a warning is surfaced. On completion `e` prints the run's branch name so the user can merge, cherry-pick, or open a PR themselves (no auto-merge). All git and push credentials run in the host `e` process; the container is never given credentials (ADR-0002).

## Acceptance criteria

- [ ] A run that exits 0 with commits beyond base pushes its branch to origin.
- [ ] A run that exits non-zero does not push, and its branch is kept locally.
- [ ] A run that exits 0 but produced no commits does not push (no empty branch on origin).
- [ ] A push failure does not fail the run: the branch remains locally and a warning is shown.
- [ ] The run's branch name is printed on completion.
- [ ] Integration back to the user's branch is left to manual git; `e` performs no merge or rebase.
- [ ] Push credentials are never passed into the container.
- [ ] Covered by `runSpawn` `node:test` tests with a fake `Git`: push on exit0+commits, no-push on non-zero exit, no-push on zero commits, and push-failure-is-non-fatal.

## Blocked by

- https://github.com/BelphegorPrime/e/issues/2
