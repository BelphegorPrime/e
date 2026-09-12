# 32 - serve: detect stale detached pid in serve.json (host reboot)

**Status:** Done (closed 2026-09-05).

**GitHub:** [#28](https://github.com/BelphegorPrime/e/issues/28)

---

## Problem

`e serve` detached mode (`E_SERVE_DETACHED`) writes a pid/host/port to
`serve.json`; on re-invocation it reports "already serving". After a host
reboot the pid is stale but the file persists — the client may think the UI
is up when it is not.

## Scope

Verify (and fix if needed) stale-detection:

- Check `serve.json` owner pid is alive before reporting "already serving".
- Health-probe the recorded host:port as an alternative / in addition.
- Clear the state file when the server is stopped or found dead.

## Tasks

- [ ] Stale-pid detection on re-invocation
- [ ] Tests: stale entry falls through to starting a fresh server
- [ ] Reference: `docs/security/attack-surface.md`, Zone 4, item 5

## Blocked by

- (none) — minor cleanup.
