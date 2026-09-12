# 27 - Skills: baked agent defaults + per-run --skill

**Status:** Done (closed 2026-08-08).

**GitHub:** [#16](https://github.com/BelphegorPrime/e/issues/16)

---

## What to build

Add **Skills** as a Store citizen (`.e/skills/<name>/`, `e init` ships some, users add their own) per ADR-0006. An Agent may declare a default set of skills baked into its image; `e spawn … --skill <name,…>` adds skills per-run via the runtime overlay. The per-harness **adapter** places skills at the path its CLI reads, outside `/workspace` (e.g. Claude `~/.claude/skills/`, the shared `.agents/skills/` for others), and only harnesses that support skills receive them (capability gating).

## Acceptance criteria

- [ ] `.e/skills/<name>/SKILL.md` layout defined; `e init` ships ≥1 skill; agent-declared default skills are baked into the agent image.
- [ ] `--skill <name,…>` delivers skills at runtime to the harness-specific path, outside `/workspace`.
- [ ] Each Harness declares skill support; an unsupported harness is gated with a clear message.
- [ ] Skills never render into the worktree or the run branch's diff.
- [ ] Tests for skill placement and baked-vs-per-run; `npm test` passes.

## Blocked by

- #11
