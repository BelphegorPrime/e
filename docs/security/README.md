# Security notes

The security review material for `e` lives here. The repo keeps the
**analysis** and the **implementation tracking** separate: this directory
holds the analysis, and the fix work items live in
[`docs/tickets/`](../tickets/README.md) as write-up-first tickets until their
GitHub issues exist (see `docs/agents/issue-tracker.md`).

## Documents

| File                                     | What it is                                                                                                                              | Status                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [`attack-surface.md`](attack-surface.md) | The written attack-surface review: four execution zones (container, store, compose stack, `serve` BFF), threat model, recommended fixes | Review draft; refreshed 2026-09-11 and 2026-09-13 |

## Findings (write-up first, 2026-09-13)

Security pass over the shared egress namespace, the runtime-broker, and the
`serve` BFF, following up the shipped fixes (tickets 28-32). Each file carries
its full problem/scope/tasks; GitHub issues are pending host-side creation.

| Ticket                                                                   | Finding                                                                                                                        | Zone           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| [`70`](../tickets/70-serve-authenticate-bff-beyond-loopback.md)          | Only the A2A endpoint is bearer-guarded; terminal, manual-child, runs-index and egress-proxy routes stay open on any interface | 4 (`serve`)    |
| [`71`](../tickets/71-egress-mutation-api-auth-and-per-run-scope.md)      | Egress mutation API unauthenticated, globally scoped, reachable by every run (cross-run DoS + DNS-log leak)                    | 1 (run/egress) |
| [`72`](../tickets/72-secrets-files-0600-on-host.md)                      | `.e/.env` written world-readable (0644) on the host                                                                            | 2 (store)      |
| [`73`](../tickets/73-broker-authz-and-port-collision-in-shared-netns.md) | Broker unauthenticated + fixed-port collision in the shared egress namespace                                                   | 1 (run/egress) |

## How to add a finding

1. Write the ticket file `docs/tickets/NN-slug.md` (next free number) in the
   `70`-`73` style: Status, GitHub (pending), Problem, Scope, Tasks, Blocked by.
2. Add a row to the Security review section of `docs/tickets/README.md`.
3. Update `attack-surface.md`: strike-through the stale claim if one exists,
   add the fact to its zone table, add a row to the recommended-fixes table,
   and append the ticket to References.
