# 29 - OmniRoute: bind 127.0.0.1, generate stack secrets at e init (drop local-development defaults)

**Status:** Done (closed 2026-09-05).

**GitHub:** [#25](https://github.com/BelphegorPrime/e/issues/25)

---

## Problem

The local compose stack binds OmniRoute to `0.0.0.0:20128` with hardcoded
default secrets (`renderCompose.ts`):

- `INITIAL_PASSWORD=${OMNIROUTE_INITIAL_PASSWORD:-local-development}`
- `JWT_SECRET=${JWT_SECRET:-local-development-jwt-secret-32-bytes}`
- `API_KEY_SECRET=${API_KEY_SECRET:-local-development-api-key-secret-32-bytes}`

On an untrusted LAN any machine can open the dashboard and log in with the
well-known default password.

## Scope

1. Bind the OmniRoute port to `127.0.0.1:20128:20128` in `renderCompose.ts`.
2. `e init` generates fresh random `OMNIROUTE_INITIAL_PASSWORD`, `JWT_SECRET`,
   `API_KEY_SECRET` into `.e/.env` (only when absent, so a re-init never
   rotates a value the user already set).
3. Remove the `:-local-development` fallbacks from the compose template.
4. Update the hardcoded `local-development` references in `spawn.ts`
   (prompt text ~line 101, accepted-key check ~line 308) to read the
   generated password from the store env.

## Blocked by

- #24 (env injection whitelist): the stack secrets must not reach a
  container until `.e/.env` injection is filtered.

## Tasks

- [ ] Port bind: `127.0.0.1:20128:20128`
- [ ] Secret seeding in `init.ts` (randomBytes; preserve existing values)
- [ ] Remove hardcoded compose defaults
- [ ] `spawn.ts` prompt + key check read `OMNIROUTE_INITIAL_PASSWORD`
- [ ] Tests: renderCompose port + no-default assertion; init seeding test
- [ ] Reference: `docs/security/attack-surface.md`, Zone 3
