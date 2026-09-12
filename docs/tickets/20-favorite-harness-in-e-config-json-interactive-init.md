# 20 - Favorite harness in .e/config.json + interactive init + bare e spawn

**Status:** Done (closed 2026-08-08).

**GitHub:** [#9](https://github.com/BelphegorPrime/e/issues/9)

---

## What to build

Add a host-only Store config file `.e/config.json` holding `defaultHarness` (glossary Store; ADR-0004). Make `e init` interactive: prompt for the favorite harness (default `pi`, preselected) and for the required API keys (written into `.e/.env`). Extend spawn resolution so `e spawn "<prompt>"` with no harness/agent named resolves to the favorite harness → its default agent. Unlike `.e/.env`, `.e/config.json` is never injected into any container.

## Acceptance criteria

- [ ] `.e/config.json` read/written by the Store module; `defaultHarness` defaults to `pi`.
- [ ] `e init` prompts for the favorite harness (default `pi`) and API keys; writes `config.json` + `.e/.env`; a non-interactive/CI path still works (flag or env to skip prompts).
- [ ] `e spawn "<prompt>"` (no name) runs the favorite harness's default agent end-to-end.
- [ ] `.e/config.json` is never passed to a container.
- [ ] Tests for the resolution fallback and `config.json` read/write; `npm test` passes.

## Blocked by

- #8
