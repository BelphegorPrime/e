# 12 - Spec: isolate every run in a per-run git worktree (host-driven git)

**Status:** Done (closed 2026-08-08).

**GitHub:** [#1](https://github.com/BelphegorPrime/e/issues/1)

---

## Problem Statement

Today `e spawn <harness> <prompt>` runs a Harness by bind-mounting the current working directory straight into the container and letting the agent edit those real files live, with `--dangerously-skip-permissions`. When the container exits (`--rm` defaults on) the container is gone and the only trace of the Run is whatever it mutated on disk.

From a user's perspective this has three problems:

- **No isolation.** A misbehaving or prompt-injected agent mutates my actual working tree. I can't safely walk away from a Run.
- **Runs collide.** If I Spawn two Runs against the same directory they trample each other, so I can't fan out work — which is the whole point of an orchestrator.
- **No clean result boundary.** There's no "here is exactly what this Run produced" artifact I can review, keep, or throw away.

## Solution

Every Run executes in its own isolated **git worktree** on its own branch, created and managed on the host, and the container only ever sees that worktree at `/workspace`. A Run becomes a first-class, branch-shaped artifact:

- I Spawn a Run; `e` derives a readable name from my prompt, cuts a fresh worktree from my current `HEAD`, and runs the Harness against it.
- While the agent works, my real working tree is untouched and other Runs are unaffected.
- When the agent exits, `e` makes sure the work is captured as commit(s) on the Run's branch, tears down the disposable worktree, keeps the branch, and — if the Run succeeded — pushes the branch to origin so I can open a PR or merge on my own schedule.
- All git and all credentials stay on the host; the unsupervised agent sandbox never holds my push keys.

The result: I can fire off many Runs, each producing a clean branch I can review with ordinary git, without any Run endangering my working tree or another Run.

## User Stories

1. As a developer, I want each Run to operate on an isolated copy of my repo, so that an agent can't damage my real working tree.
2. As a developer, I want to Spawn multiple Runs against the same repo at once, so that they don't collide with each other.
3. As a developer, I want a Run's worktree branched from my current local `HEAD`, so that the agent starts from exactly the committed state I'm looking at.
4. As a developer, I want my uncommitted local edits to stay out of the Run, so that half-finished work doesn't leak into an agent's starting point.
5. As a developer, I want each Run named with a short, readable slug derived from my prompt, so that I can recognize its branch at a glance among many branches.
6. As a developer, I want the Run slug to look like a normal branch name (e.g. `create-cool-feature`), so that it fits the branch conventions I already use.
7. As a developer, I want to override the generated name with `--name`, so that I can label a Run myself when I care to.
8. As a developer, I want repeated Runs from the same prompt to get an incrementing counter (`-1`, `-2`), so that names stay unique and ordered without my intervention.
9. As a developer, I want concurrent Spawns with the same slug to never clobber each other's branch, so that fan-out is safe.
10. As a developer, I want `e` to find the next counter from existing Run branches, so that numbering is correct without a separate database to maintain.
11. As a developer, I want the Harness container to mount the Run's worktree at `/workspace`, so that the agent works only inside its isolated checkout.
12. As a developer, I want the agent's changes committed to the Run branch when it exits, so that I never lose work that the agent left uncommitted.
13. As a developer, I want `e` to leave the agent's own commits alone when the tree is already clean, so that my history isn't cluttered with redundant commits.
14. As a developer, I want the worktree removed after the Run but the branch kept, so that disk stays lean while the durable result survives.
15. As a developer, I want a successful Run's branch pushed to origin automatically, so that it's immediately available for a PR or review.
16. As a developer, I want a Run to be considered successful only when the agent exits 0 and produced commits, so that aborted or no-op Runs don't litter origin.
17. As a developer, I want a failed or empty Run's branch kept locally and not pushed, so that I can inspect it without polluting the remote.
18. As a developer, I want a push failure (no remote, auth, rejection) to be non-fatal, so that a Run never loses work just because it couldn't reach origin.
19. As a developer, I want `e` to tell me the Run's branch name when it finishes, so that I know exactly what to merge, cherry-pick, or open a PR from.
20. As a developer, I want to integrate a Run's work with my own git commands rather than have `e` auto-merge, so that Runs respect my review workflow.
21. As a developer, I want `e` to refuse to Spawn outside a git repository with a clear message, so that I'm never surprised by a Run with no isolation.
22. As a developer, I want my git push credentials to stay on the host and never enter the container, so that an unsupervised agent can't exfiltrate them.
23. As a developer, I want each Harness to still receive the environment it needs from the shared `.e/.env`, so that Spawning keeps working as before.
24. As a developer, I want the existing `--runtime`, `--rebuild`, `--dir`, `-e`, `--env-file`, `-p`, and `--name` options to keep working, so that the redesign doesn't break my current usage.
25. As a developer, I want to still stream the agent's output in my terminal during a Run, so that I can watch it work.
26. As a developer running many Runs, I want the branch namespace scoped per Harness (`e/<harness>/<slug>-N`), so that Runs from different Harnesses don't collide in naming.

## Implementation Decisions

**Domain vocabulary** (from `packages/cli/CONTEXT.md`): Harness, Run, Runtime, Spawn. Governed by ADRs `0001-per-run-git-worktree`, `0002-host-orchestrates-git`, `0003-run-identity-and-ledger`.

**New seam — a `Git` port.** Introduce a `Git` abstraction (mirroring the existing `ContainerRuntime` abstraction) covering exactly the host git operations a Run needs:

- Assert the workspace is a git repository.
- List existing Run branches matching `e/<harness>/<slug>-*` (local and already-fetched remote-tracking refs) to compute the next counter.
- Add a worktree on a new branch from local `HEAD`, atomically (creation fails if the branch/worktree already exists).
- Report whether the worktree has uncommitted changes; commit them (`add -A` + commit) on the Run branch.
- Report whether the branch has commits beyond its base ref.
- Push the branch to origin.
- Remove the worktree (keeping the branch).

**New seam — a `runSpawn` orchestrator.** A function composing a `Git` and a `ContainerRuntime` that drives the Run lifecycle:

1. Resolve the Harness and Runtime (reuse existing `resolveHarness` / `resolveRuntime`).
2. Require a git repo (else exit with a clear error).
3. Derive the slug from the prompt (deterministic slugify: lowercase, non-alphanumerics → hyphens, drop stop-words, truncate to a word boundary under ~40 chars); `--name` overrides the slug.
4. Compute the run name `<slug>-N` where `N` = max existing counter + 1; on atomic-create collision, bump `N` and retry.
5. Create the worktree from `HEAD` on branch `e/<harness>/<slug>-N`.
6. Build the image if needed and run the container with the worktree mounted at `/workspace` (reuse existing build/run path), streaming stdio.
7. On exit: if the worktree is dirty, commit; otherwise leave the agent's commits.
8. Remove the worktree, keep the branch.
9. If the container exited 0 **and** the branch has commits beyond base, push to origin; a push failure is warned and swallowed.
10. Print the resulting branch name.

**Thin commander action.** `registerSpawnCommand`'s `.action()` becomes a thin wrapper: parse options, construct the real `Git` and `ContainerRuntime`, call `runSpawn`, and translate its result into process exit codes. No lifecycle logic lives in the callback.

**Credentials & git location** (ADR-0002): all git runs in the host `e` process. The container receives only the shared `.e/.env` (whole file, unchanged from today) and retains full network egress (documented gap, not addressed here).

**Environment loading** unchanged: shared `.e/.env` as base, then `--env-file`, then `-e` overrides.

**Branch namespace:** `e/<harness>/<slug>-N`. Worktree directory and container name derive from the same run name.

**Non-goals encoded as decisions:** no auto-merge, no `e merge`/`e pr` helpers, no least-privilege secret scoping, no egress restriction, no separate run-state file.

## Testing Decisions

**What makes a good test here:** assert externally observable _decisions_ of the orchestrator, not internal call mechanics. Tests drive `runSpawn` (and the pure `slugify` helper) with a **fake `Git`** and **fake `ContainerRuntime`**, and assert the observable outcomes — which branch name was created, whether a commit was made, whether a push happened, what exit behavior resulted — never private methods or file paths.

**Runner:** the repo has no test framework (only the smoke test in `test-build.ts` that shells out to `--help`). Use Node's built-in `node:test` + `node:assert` (no new dependencies, fits Node 24), wired into the package `test` script.

**Modules tested:**

- `slugify` — pure function: casing, hyphenation, stop-word dropping, length/word-boundary truncation, empty/multi-line prompts.
- `runSpawn` orchestrator with fakes — the behavioral core:
  - Errors (non-zero exit) when the workspace is not a git repo, without touching the Runtime.
  - Derives run name `e/<harness>/<slug>-1`; with existing `-1`, uses `-2`; on atomic-create collision, retries with the next counter.
  - `--name` overrides the slug.
  - Commits when the worktree is dirty; does not commit when clean.
  - Always removes the worktree; always keeps the branch.
  - Pushes only when exit code is 0 **and** there are commits beyond base; does not push on non-zero exit, and does not push when there are no commits.
  - A push failure does not fail the Run (branch preserved, warning surfaced).
  - Reports the branch name on completion.

**Prior art:** `packages/cli/src/test-build.ts` is the only existing test (smoke-level). The fakes-driven approach is new to this repo and establishes the pattern for the orchestrator.

## Out of Scope

- `e merge <run>` / `e pr <run>` and any auto-merge or rebase-onto-base behavior — handoff stays manual git.
- Least-privilege secret scoping — the whole shared `.e/.env` continues to reach every Harness.
- Container network egress restriction / allowlist — full egress remains, documented as a known gap.
- A managed run-state/index file (`runs.json`) and any orchestrator status/timing/log tracking — git branches remain the sole source of truth.
- Re-materializing a worktree on demand (`e open <run>`), listing Runs (`e ls`), or removing Runs (`e rm`) — future commands, not this spec.
- Carrying uncommitted local changes into the worktree — explicitly excluded (base is clean `HEAD`).
- The UI ↔ backend contract and the broader orchestration model — separate design trees, not yet grilled.

## Further Notes

- This spec was produced from a `/grill-with-docs` session; the resulting decisions are recorded in `packages/cli/CONTEXT.md` and ADRs `0001`–`0003` under `packages/cli/docs/adr/`.
- The current `spawn.ts` still bind-mounts the CWD in place; this spec replaces that path entirely with the worktree model. `--rm`-on-exit and foreground `--attach` container behavior are retained.
- Two accepted risks are deliberately carried forward (full container egress; whole-`.env` injection) and documented in ADR-0002 so a future reader doesn't mistake them for oversights.
