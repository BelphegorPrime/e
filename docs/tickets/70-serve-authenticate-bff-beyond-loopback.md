# 70 - serve: authenticate the BFF beyond loopback (only A2A is bearer-guarded today)

**Status:** Open, needs-triage.

**GitHub:** Pending - will mirror the created issue.

## Problem

`a2aAccess` (`src/engine/a2a/access.ts`) gates exactly one route: the A2A
JSON-RPC endpoint. When `e serve --host <non-loopback>` opens the BFF to a
network, everything else it mounts stays unauthenticated:

- `POST /api/terminal/sessions` starts a headless `e spawn`: a run in the
  user's checkout with full repo write access (ADR-0002: harness runs
  unsupervised).
- `POST /api/runs/<branch>/siblings` spools a manual child request for any
  run branch (`src/cli/serve/spawnApi.ts`).
- `/api/runs/*` index, `/api/egress/*` proxy, `GET /api/terminal/*` and the
  OmniRoute embed proxy all answer without credentials
  (`src/cli/serve/serveApp.ts`, `reverseProxy.ts`).
- The agent card advertises bearer gating only for the A2A endpoint; a LAN
  peer with the UI URL gets the whole rest of the surface.

The A2A-only gate reads like a complete gate: `a2aAccess` returns
"enabled: false" without a token, so `serve --host 0.0.0.0` passes A2A off
with a warning while the far more powerful terminal/spawn routes stay open.

ADR-0014 and `docs/security/attack-surface.md` (Zone 4) say "auth becomes
required" where serve is opened; today only the A2A slice honours that.

## Scope

Decide and implement one auth model for the whole BFF when bound beyond
loopback:

- Reuse `E_A2A_TOKEN` as the BFF-wide bearer (smallest surface: the token
  already exists and the A2A client already sends it), or introduce a
  dedicated `E_SERVE_TOKEN`.
- Same policy shape as `a2aAccess`: on loopback optional, off loopback
  mandatory; token set or the endpoints stay off / the server refuses to
  bind beyond loopback.
- The reverse-proxied egress mutations (`/api/egress/*`) inherit the gate
  automatically; verify no bypass via the embed-proxy port (BFF port + 1).
- Keep the A2A card's `bearer` field truthful for the whole surface.

## Tasks

- [ ] Extend the access decision from `a2aAccess` to the app assembly in `serveApp.ts` (or move the gate to a middleware over `/api` + the A2A path)
- [ ] Apply the same bearer check to terminal sessions, spawn, runs index and egress proxy
- [ ] Refuse (with a clear message) or warn loudly when `--host` is beyond loopback with no token configured
- [ ] Tests: `serveApp.test.ts` / `access.test.ts` - non-loopback host, no token: start-a-run routes 401/off; with token: bearer required across all routes; loopback unchanged
- [ ] Reference: `docs/security/attack-surface.md`, Zone 4

**Blocked by:** None - can start immediately. Related: 29 (OmniRoute bind + secrets, done) set the precedent for loopback-or-auth decisions.

## Why now

`serve --host` is the documented path to expose the A2A facade (ADR-0015);
the moment it is used, the whole run-starting surface goes public. This is
the sharpest open item after the Zone 1-3 fixes shipped (tickets 28-32).
