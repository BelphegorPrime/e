# 71 - egress: mutation API is unauthenticated, globally scoped, and reachable by every run

**Status:** Open, needs-triage.

**GitHub:** Pending - will mirror the created issue.

## Problem

The egress container is a **global** stack service (ADR-0011): one dnsmasq +
iptables instance whose network namespace every run agent and stack service
shares (`netns: EGRESS_CONTAINER` in `executeSpawn.ts`; compose runs it once
in `renderCompose.ts`). Its HTTP API binds `0.0.0.0:20129`
(`src/sidecars/egress/server/api.ts`) with **no authentication**:

- any run agent can reach it at `localhost:20129` from the shared namespace,
- `POST /blacklist/domains` and `DELETE /blacklist/domains/{domain}` mutate
  the **global** blacklist, then SIGHUP the entrypoint to restart dnsmasq.

Consequences for a compromised / prompt-injected agent:

- **Cross-run DoS.** Blacklist `api.anthropic.com` (or OpenAI, the MCP
  endpoints of other runs, `github.com` for sibling merges, ...) and every
  concurrent run - plus the stack services - loses that egress until someone
  operator-side deletes the entry. The agent can even sinkhole its own
  provider, taking itself and everyone else down together.
- **Control-plane weakening.** `DELETE` removes entries the operator added;
  with a pure default-allow blacklist that is not a widening of egress, but
  the mutation surface is still host-orchestrated control plane the untrusted
  party can write.
- **Cross-run monitoring leak.** `GET /logs*` answers the shared dnsmasq
  query log; any run can read which hostnames every other run resolves
  (privacy/opsec between runs sharing the netns).

Compare: serve loopback reasoning ("anyone there could run e spawn anyway")
does not apply here - the _untrusted agent itself_ is the caller, and the
mutation is global, not per-run.

## Scope

Keep the blacklist + monitoring design (ticket 31) but make the API:

- **Authenticated** for mutations: a token the agent does not hold. The host
  CLI (`e spawn`, `e egress ...`) and the BFF proxy are the only writers.
- **Per-run scoped or read-mostly toward agents**: monitor reads may stay
  open (or go behind the same auth); writes must not affect other runs.
  Options: per-run iptables/dnsmasq state, or a per-run write token and a
  deny-by-default stance on removing another run's entries.
- Optionally **localize the listen**: `127.0.0.1` inside the egress netns is
  not enough (agents share that loopback), so auth or net-policy is the real
  fix; document that.

## Tasks

- [ ] Add a mutation token (env into the egress container, never into run agents) checked on POST/DELETE blacklist routes
- [ ] Thread the token to the BFF egress proxy and the CLI writer only
- [ ] Decide per-run blacklist scope or keep global + auth + audit (SIGHUP log) - document the choice in ADR-0011
- [ ] Tests: `egress/server/api.test.ts` - unauthenticated POST/DELETE 401; token correct mutates; GET logs unchanged
- [ ] Update `docs/security/attack-surface.md`, Zone 1 egress row

**Blocked by:** None. Related: 31 (egress blacklist monitor) shipped the API as-is; this closes its authz hole.

## Why now

The netns-everyone-shares design means the egress API is the one control
plane a run agent hits directly. With ticket 31 done, this is the remaining
egress gap.
