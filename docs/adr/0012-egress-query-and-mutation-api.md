# ADR-0012: Egress Query and Blacklist-Mutation API on the Egress Container
**Status:** Accepted
**Date:** 2026-09-10
**Related:** [ADR-0003 (run identity)](./0003-run-identity-and-ledger.md), [ADR-0010 (serve BFF, observer-first UI)](./0010-serve-is-a-bff-observer-first-ui.md), [ADR-0011 (global egress container)](./0011-egress-blacklist-netns.md)
## Decision
The `e-egress` container (ADR-0011) gains a small HTTP interface so its
own logs are queryable and its blacklist is mutable at runtime. The interface
lives on the container itself — the module that owns the log and the
blacklist files owns their read and write shape (locality). `serve` (ADR-0010)
proxies the surface under `/api/egress/*`; the UI may call it, with the sole
mutation being domain blacklisting (ADR-0010 amendment).
## Decisions
### A query interface over the mounted dnsmasq log
`GET /logs` returns mapped log entries filtered by `since`/`domain`/`action`/
`limit`. Squash: `GET /logs/squashed` collapses consecutive same-domain
entries into `{ domain, count, firstSeen, lastSeen }`. Localhost and
stack-internal names are dropped before the view — they are noise, not egress
signal. The API is stateless: it reads the mounted log file and squashes per
call; no resident tailer, no persistence. Optional later storage (shipper to
Elasticsearch/Loki/S3) does not change the interface.
### A mutation interface over the host-mounted blacklist
`POST /blacklist/domains` (add) and `DELETE /blacklist/domains/:domain`
(remove) write the host-mounted `dnsmasq.blacklist` file and trigger the
existing SIGHUP reload, so a block is accepted and applied immediately — no
restart of the shared netns (ADR-0011). Blacklist state stays in the host
file; the API is a thin writer over it, never a second source of truth.
### The BFF proxies; it does not write
`serve` forwards `/api/egress/*` to the container API — the same proxy shape
as `/api/runs/*`. No write layer, no auth surface of its own; this is the one
delegated mutation ADR-0010 allows.
## Consequences
- **Small interface, deep implementation**: the container hides dnsmasq log
  parsing, squash, and blacklist file handling behind four endpoints.
- **Immediate effect by construction**: SIGHUP reload was already the
  mechanism; the API just names it.
- **UI stays observer-first in spirit**: one mutation path, fully mediated.
- **No new auth surface**: the egress API binds inside the private stack
  network (as OmniRoute does); only the local BFF reaches it.