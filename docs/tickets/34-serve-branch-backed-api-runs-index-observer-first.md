# 34 - serve: branch-backed /api/runs/* index + observer-first read-only UI

**Status:** Done (closed 2026-09-05).

**GitHub:** [#30](https://github.com/BelphegorPrime/e/issues/30)

---

## Context

ADR-0010 decides the runs index (`/api/runs/*`) is branch-backed:
`refs/heads/run/*` per ADR-0003, until the UI needs live timing or streaming
logs.

## Work

- [ ] Implement `/api/runs/*` over git branches (list, per-run status, logs).
- [ ] Wire it behind `serve`'s `/api` root next to `/api/info`.
- [ ] Deliberately do **not** build live log/timing views yet; the namespace
      stays extensible.
- [ ] (Q1 rest) The observer-first, read-only UI contract: no write endpoints,
      no session/auth (local-only, `127.0.0.1` bind).

## Blocked by

- (none) — independent; the UI is a stub today, so this lands as `serve`
  grows into the BFF.
