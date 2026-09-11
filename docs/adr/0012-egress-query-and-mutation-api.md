# ADR-0012: Egress Query and Blacklist-Mutation API on the Egress Container

**Status:** Accepted
**Date:** 2026-09-10
**Related:** [ADR-0003 (run identity)](./0003-run-identity-and-ledger.md), [ADR-0010 (serve BFF, observer-first UI)](./0010-serve-is-a-bff-observer-first-ui.md), [ADR-0011 (global egress container)](./0011-egress-blacklist-netns.md)

## Decision

The `e-egress` container (ADR-0011) gains a small HTTP interface so its
own logs are queryable and its blacklist is mutable at runtime. The interface
lives on the container itself - the module that owns the log and the
blacklist files owns their read and write shape (locality). `serve` (ADR-0010)
proxies the surface under `/api/egress/*`; the UI may call it, with the sole
mutation being domain blacklisting (ADR-0010 amendment).

## Decisions

### A query interface over the mounted dnsmasq log

`GET /logs` returns mapped log entries filtered by `since`/`domain`/`action`/
`limit`. Squash: `GET /logs/squashed` rolls the whole log up to one
`{ domain, count, firstSeen, lastSeen }` record per normalized domain
(lowercase, trailing dot stripped), sorted by count descending. Collapsing only
consecutive entries was rejected: interleaved traffic yields thousands of rows
for a handful of domains. Localhost and stack-internal names are dropped before
the view - they are noise, not egress signal. The API is stateless: it reads the mounted log file and squashes per
call; no resident tailer, no persistence. Optional later storage (shipper to
Elasticsearch/Loki/S3) does not change the interface.

### A mutation interface over the host-mounted blacklist

`POST /blacklist/domains` (add) and `DELETE /blacklist/domains/:domain`
(remove) write `address=/domain/0.0.0.0` and `address=/domain/::` lines to the
host-mounted `dnsmasq.blacklist` file, then send SIGHUP to the egress
entrypoint, which restarts its dnsmasq child (dnsmasq does not re-read
`--conf-dir` on HUP). A block therefore applies within about a second without
recreating the shared netns (ADR-0011). `GET /blacklist/domains` returns
`{ domains: string[] }`, the parsed host file, so the UI renders block state
without a second source of truth. Blacklist state stays in the host file; the
API is a thin writer over it. Domains are validated as DNS names before they
are written: anything else could inject dnsmasq directives and take the shared
resolver down.

### The BFF proxies; it does not write

`serve` forwards `/api/egress/*` to the container API - the same proxy shape
as `/api/runs/*`. No write layer, no auth surface of its own; this is the one
delegated mutation ADR-0010 allows.

## Consequences

- **Small interface, deep implementation**: the container hides dnsmasq log
  parsing, squash, and blacklist file handling behind five endpoints plus
  `/health`.
- **Immediate effect by construction**: the entrypoint's HUP-triggered dnsmasq
  restart was already the mechanism; the API just names it.
- **UI stays observer-first in spirit**: one mutation path, fully mediated.
- **No auth of its own**: the API listens inside the shared egress netns and is
  published on host loopback (`127.0.0.1:20129`) for the BFF. Any local
  process, and any container in the egress namespace (the agent included), can
  therefore mutate the blacklist; the input validation above bounds the damage
  to blocking or unblocking domains.
