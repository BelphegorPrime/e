# 73 - broker: unauthenticated API reachable from any run in the shared egress namespace

**Status:** Open, needs-triage.

**GitHub:** Pending - will mirror the created issue.

## Problem

The runtime-broker (ADR-0013) is an HTTP front for the run's spool: no auth,
binds `0.0.0.0:${BROKER_PORT}` (20130) inside its sidecar
(`src/sidecars/broker/server/api.ts`, `src/engine/runs/runBroker.ts`). By
design it receives no docker socket and no credentials - it only spools
requests for the host `e` process. Its trust assumption is **network
isolation**: only the run group can reach it.

That assumption breaks in the shared egress namespace (stack present): every
run agent AND every other run's broker share the one netns, so:

- Any run agent can reach **another run's** broker at `localhost:20130` and
  `POST /spawn` (spool a sibling request for a run whose consumer it is
  not), `POST /merge/<id>` (signal a merge it does not own), or
  `POST /cancel/<id>`. Those are the parent's per-sibling signals (ADR-0015).
- Multiple brokers in one netns also collide on the fixed port: the second
  broker fails to bind, which `runSpawn.ts` already half-anticipates with
  "in the shared egress namespace its port may already be taken by another
  run" - sibling support silently dies when two runs with the skill overlap.
  EGRESS_API_PORT (20129) and BROKER_PORT (20130) are fixed constants, so
  runs with the spawn-brother skill in a shared netns cannot coexist today.

## Scope

Decide the broker's identity model in the shared namespace:

- **Per-run port** alongside the shared controls: give the broker a unique
  loopback port per run (like the sidecar probes do) so a child can reach
  only its own parent's broker; the `BROKER_PORT` constant becomes a base.
- **Or per-run auth**: a per-run token (spooled by the host into the broker
  env, never into agents) checked on every request; children pass it in the
  broker URL.
- **Or refuse**: in the shared egress namespace, run with the
  spawn-brother skill fails fast with a clear message (and UI reflects a
  state where sibling support is unavailable) instead of a colliding bind.

Also verify what a cross-run `POST /spawn` can actually achieve from the
host consumer's side (it re-invokes `e spawn` with the child markers from
the spool - confirm a forged request cannot name a parent branch/network
outside the host's intended set).

## Tasks

- [ ] Reproduce: two runs with spawn-brother in a shared egress namespace - second broker bind failure / cross-reach
- [ ] Pick one of per-run port / per-run token / refuse-and-document; implement in `sidecarPlan.ts` + `runBroker.ts` + broker `cli.ts`
- [ ] Ensure the `spawn-brother` skill script's hardcoded port story (URL the script builds) follows the new addressing
- [ ] Tests: broker API rejects a request without the run's token (if auth path), or port-allocated per run; cross-run spool attempt covered
- [ ] Reference: `docs/security/attack-surface.md`, Zone 1 (sidecar) + ADR-0013

**Blocked by:** None. Related: 02 (broker sidecar, done 2026-09-12) shipped the no-auth/no-socket design; this closes the shared-netns hole.

## Why now

Sibling spawning is the newest shipped surface (ADR-0013 series, tickets
01-08). The shared egress namespace is the default stack setup, so the
broker isolation assumption fails in the common configuration.
