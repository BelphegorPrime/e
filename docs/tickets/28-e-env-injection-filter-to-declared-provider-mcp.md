# 28 - .e/.env injection: filter to declared provider + MCP keys (whitelist)

**Status:** Done (closed 2026-09-05).

**GitHub:** [#24](https://github.com/BelphegorPrime/e/issues/24)

---

## Problem

`executeSpawn.ts` composes the run's env-files starting from the store's
`baseEnvFile` (`.e/.env`), and the **whole file** is passed to every agent
container. Any secret a user keeps in `.e/.env` — not just the keys the run's
provider and MCP servers declare — is visible to the untrusted harness agent.

## Scope

Filter the base env-file before it reaches a container. Allowed keys:

- the run's provider `apiKeyEnv` and `baseUrlEnv`
- `requiredEnv` of the run's sidecar and remote MCP servers
- the global `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` template lines

Unknown keys stay in `.e/.env` (readable by the user's own shell) but never
enter a container.

## Tasks

- [ ] Add the whitelist filter to the env-file composition (spawnPlan or executeSpawn)
- [ ] Update `executeSpawn.ts` to apply the filter to `baseEnvFile` before `orderEnvFiles`
- [ ] Keep per-harness template sections unchanged (separate channel via the config adapter)
- [ ] Tests: `runSpawn.test.ts` / `harness/adapter.test.ts` — assert filtered-in vs. filtered-out keys
- [ ] Reference: `docs/security/attack-surface.md`, Zone 2

## Why now

Q4b-1 (randomized OmniRoute stack secrets in `.e/.env`) is blocked on this:
the stack secrets must not reach a container until injection is filtered.
