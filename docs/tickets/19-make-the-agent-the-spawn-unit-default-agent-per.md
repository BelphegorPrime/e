# 19 - Make the Agent the spawn unit (default agent per harness)

**Status:** Done (closed 2026-08-08).

**GitHub:** [#8](https://github.com/BelphegorPrime/e/issues/8)

---

## What to build

Introduce the **Agent** as the unit `e spawn` executes (ADR-0004), _without_ building derived images yet. `e init` writes a default `agent.json` per harness under `.e/agents/<name>/` (harness reference + `tier: default`, no custom provider). `e spawn <name>` resolves `<name>` as an Agent when it matches one, otherwise as a Harness → that harness's default agent. The run branch becomes `e/<agent>/<slug>-N` (was `e/<harness>/…`). A default agent runs the existing harness base image exactly as today (single container, per-run worktree) — only identity and resolution change.

## Acceptance criteria

- [ ] `.e/agents/<name>/agent.json` schema defined (harness, tier); `e init` writes one default agent per harness and does not overwrite a hand-edited file (diff, like harness Dockerfiles).
- [ ] `resolveAgent(name)` resolves an agent name, else a harness name → its default agent; unknown → clear error listing valid agents/harnesses.
- [ ] Run branch/counter use the agent prefix `e/<agent>/<slug>-N` (`listRunBranches`/`maxRunCounter` updated).
- [ ] `e spawn <harness> "…"` still works end-to-end via the default agent; single container, runtime behavior unchanged.
- [ ] Glossary and ADR-0004 respected; `npm test` passes with tests for agent resolution and the branch prefix.

## Blocked by

None - can start immediately
