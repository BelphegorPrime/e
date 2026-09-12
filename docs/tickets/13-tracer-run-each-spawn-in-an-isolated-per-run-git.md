# 13 - Tracer: run each spawn in an isolated per-run git worktree

**Status:** Done (closed 2026-08-07).

**GitHub:** [#2](https://github.com/BelphegorPrime/e/issues/2)

---

## Parent

BelphegorPrime/e#1

## What to build

The architectural spine for the per-run worktree model, end-to-end. `e spawn <harness> <prompt>` run inside a git repository derives a slug from the prompt, creates a git worktree on a new branch `e/<harness>/<slug>` from local `HEAD`, builds/runs the Harness container with that worktree mounted at `/workspace` (existing build/run path, stdio streamed), and on exit commits any leftover uncommitted changes to the branch, then removes the worktree while keeping the branch. Spawning outside a git repository exits with a clear error.

This introduces the two seams the spec approved: a `Git` port (mirroring the existing `ContainerRuntime` abstraction) and a `runSpawn` orchestrator composing `Git` + `ContainerRuntime`. The commander `.action()` becomes a thin wrapper that constructs the real ports, calls `runSpawn`, and maps the result to an exit code. All git and credentials stay in the host process; the container is unchanged (whole `.e/.env` injected, full egress).

A minimal `slugify` is sufficient here; the full identity/counter rules land in the next slice. Stand up a `node:test` + `node:assert` harness (no new deps) wired into the package `test` script.

## Acceptance criteria

- [ ] `e spawn` in a git repo runs the Harness against a worktree checked out from local `HEAD` on branch `e/<harness>/<slug>`, not the working directory in place.
- [ ] The user's real working tree is never modified by a run.
- [ ] Uncommitted changes in the main working tree do not appear in the run's worktree (clean `HEAD` base).
- [ ] On agent exit, leftover uncommitted changes are committed to the run branch; a clean tree leaves the agent's own commits untouched.
- [ ] The worktree is removed after the run and the branch is kept.
- [ ] Spawning outside a git repository exits non-zero with a clear message and does not touch the Runtime.
- [ ] Existing options (`--runtime`, `--rebuild`, `--dir`, `-e`, `--env-file`, `-p`, `--name`, `--attach`/`--no-attach`, `--rm`/`--no-rm`) continue to work.
- [ ] `runSpawn` is covered by `node:test` tests using a fake `Git` and fake `ContainerRuntime`, asserting: repo-required error path, worktree created from HEAD, commit-if-dirty vs leave-clean, worktree always removed / branch always kept.

## Blocked by

None - can start immediately
