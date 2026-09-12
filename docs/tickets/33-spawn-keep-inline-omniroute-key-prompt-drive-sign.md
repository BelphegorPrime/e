# 33 - spawn: keep inline OmniRoute key prompt, drive sign-in password from store env

**Status:** Done (closed 2026-09-07).

**GitHub:** [#29](https://github.com/BelphegorPrime/e/issues/29)

---

## Context

ADR-0010 (`docs/adr/0010-serve-is-a-bff-observer-first-ui.md`) decides the
OmniRoute dashboard key prompt stays inline in `e spawn` — no `e login`
command.

## Work

Today the prompt already lives inline in `spawn.ts` (creates an API key via the
OmniRoute dashboard, writes it into `.e/.env`). This issue is the
implementation rest: with issue #25 (stack secrets randomized),
`local-development` is no longer the sign-in password, so:

- [ ] Update the sign-in instructions (currently "Sign in with the local
      password: local-development") to read the generated password from the
      store env.
- [ ] Keep the flow inline in `spawn`; do not add an `e login` command.
- [ ] Tests: prompt text reflects the store's password; key accepted check
      matches it.

## Blocked by

- #25 (OmniRoute stack secrets) — the instructions only change once the
  password is randomized. No edge needed.
