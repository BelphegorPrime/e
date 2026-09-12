# 30 - Harness containers: non-root runtime user, per-harness override

**Status:** Done (closed 2026-09-06).

**GitHub:** [#26](https://github.com/BelphegorPrime/e/issues/26)

---

## Problem

The harness Dockerfile template (`harness/renderDockerfile.ts`) has no `USER`
directive — every agent container runs as **root** with full capabilities. A
prompt-injected or compromised harness agent therefore gets root inside the
run container (no host sockets are mounted, so the blast radius is contained,
but root amplifies any future escape class).

## Scope

A non-root runtime user in the shared Dockerfile template, per-harness
overridable:

- Add a `USER` (non-root) to `renderDockerfile.ts`; `node:lts-alpine` ships a
  `node` user, so a `USER node` line plus a writable home is the baseline.
- Some harness CLIs write to their config/home dirs at runtime; decide per
  harness whether root is required and carry that as a template parameter /
  per-harness override (the harness registry owns the decision).
- Verify the run worktree bind-mount stays writable by the non-root uid
  (host uid vs. container uid mapping is the crux — the worktree is host-owned).

## Tasks

- [ ] `USER` + writable home in `renderDockerfile.ts` (default non-root)
- [ ] Per-harness override in the registry for harnesses that need root
- [ ] Verify worktree bind-mount permissions for the run uid
- [ ] Tests: renderDockerfile emits `USER`; per-harness overrides
- [ ] Reference: `docs/security/attack-surface.md`, Zone 1, item 3

## Blocked by

- (none) — independent of #24/#25.
