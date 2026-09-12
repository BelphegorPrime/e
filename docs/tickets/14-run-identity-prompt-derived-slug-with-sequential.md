# 14 - Run identity: prompt-derived slug with sequential counter

**Status:** Done (closed 2026-08-07).

**GitHub:** [#3](https://github.com/BelphegorPrime/e/issues/3)

---

## Parent

BelphegorPrime/e#1

## What to build

Give runs their full, collision-safe identity. Replace the minimal slug with the deterministic `slugify` from the spec — lowercase, non-alphanumerics to hyphens, drop stop-words, truncate to a word boundary under ~40 chars — and let `--name` override the slug entirely. Compute the run name as `<slug>-N`, where `N` is the next sequential counter found by enumerating existing `e/<harness>/<slug>-*` branches (local and already-fetched remote-tracking refs) and taking max+1. Creation is atomic: on a name collision the worktree/branch create fails, and `e` bumps `N` and retries, so concurrent spawns of the same prompt never clobber each other.

Git branches remain the sole source of truth for the counter — no separate state file (ADR-0003).

## Acceptance criteria

- [ ] A prompt produces a readable, branch-like slug (e.g. "Create a cool feature that improves usability" -> `create-cool-feature-improves-usability`), capped under ~40 chars at a word boundary.
- [ ] Stop-words are dropped and multi-line / punctuation-heavy prompts still yield a clean slug.
- [ ] `--name` overrides the derived slug and flows to branch, worktree dir, and container name.
- [ ] The first run for a slug is `<slug>-1`; with `-1` present it becomes `-2`, etc., derived from existing branches.
- [ ] The counter considers local and remote-tracking `e/<harness>/<slug>-*` refs.
- [ ] Two concurrent spawns with the same slug produce distinct branches (atomic-create-then-retry), never overwriting one another.
- [ ] Branch namespace is scoped per Harness (`e/<harness>/<slug>-N`).
- [ ] `slugify` has direct `node:test` unit tests; counter/collision behavior is covered via `runSpawn` with a fake `Git` (including a create-collision that forces a retry to the next N).

## Blocked by

- https://github.com/BelphegorPrime/e/issues/2
