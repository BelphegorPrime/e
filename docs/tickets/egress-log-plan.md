# Ticket: Egress Log Orchestration + e-egress Query/Mutation API

**Date**: 2026-09-10
**Status**: Done (ADR-0012). Steps 1-5 shipped in `src/init/renderEgress.ts`, `src/egress/*.ts`, `src/serve/serve.ts` and `ui/src/pages/egress.tsx`. Kept for history; ADR-0012 is authoritative where the two differ.
**Related ADR**: ADR-0011 (Egress Blacklist), ADR-0010 (Serve is a BFF; UI observer-first)

## Context

The `runSpawn` module previously included a stubbed, per-run `logCapture` implementation for agent egress logging. This approach was untestable and tightly coupled the orchestrator to log storage infrastructure.

The egress container (`e-egress`, ADR-0011) is the single network gate shared by agents and MCP sidecars via `--network container:e-egress`. It runs dnsmasq (domain sinkhole) + iptables (direct-IP REJECT), reads host-mounted blacklist files, and re-applies them on SIGHUP by restarting its dnsmasq child (dnsmasq does not re-read `--conf-dir` on HUP). A host edit takes effect after `docker kill -s HUP e-egress`; the API sends that signal itself after every mutation.

## Goal

Decentralize log capture from the agent run orchestrator. Centralize aggregation and add a small query + mutation interface on `e-egress`, consumed by the UI through the serve BFF.

## Plan

### 1. Decentralize Capture (The `e-egress` Container)

- `e-egress` logs every query to the mounted `/var/log/egress/dnsmasq.log` (already true today).
- No per-run code required in the agent orchestrator.

### 2. Centralize Transport (Optional log-shipper)

- For long-term storage beyond the mounted log file, attach a lightweight shipper (fluentd/promtail) as a sidecar streaming to Elasticsearch/Loki/S3.
- Short-term: the BFF reads the mounted log via the egress API; no shipper needed to ship v1.

### 3. Map (Structured Schema)

Map raw log lines to a consistent schema:

- `timestamp`: ISO8601
- `runID`: branch-based run identifier (derived from container/source context where possible)
- `domain`: queried hostname
- `protocol`: DNS/HTTP/TCP
- `action`: allow / deny(sinkholed)

### 4. Squash (Rollup)

- Consecutive same-domain entries (one after another in log order) collapse into one record: `{ domain, count, firstSeen, lastSeen }`.
- **localhost entries dropped**: queried names resolving inside the stack (`localhost`, host-names, internal addresses) never enter the squashed view - noise, not egress signal.
- Squash at ingest on the egress API side, not in the BFF or UI (locality: the module that owns the log owns its shape).
- Backend storage does periodic window rollups for long-term stats ("500 requests to `api.github.com` in 5m"). Avoid high-cardinality aggregations.

## e-egress API (new surface, small interface)

The egress container gains an HTTP interface (same container, new listener):

| Endpoint                            | Kind     | Behavior                                                                                                       |
| :---------------------------------- | :------- | :------------------------------------------------------------------------------------------------------------- |
| `GET /logs`                         | query    | Return mapped log entries (filters: `since`, `domain`, `action`, `limit`)                                      |
| `GET /logs/squashed`                | query    | Return squashed consecutive-same-domain records with counts (localhost noise dropped)                          |
| `POST /blacklist/domains`           | mutation | Add `{ domain }` → append to `dnsmasq.blacklist`, trigger SIGHUP reload - accepted immediately, blocks at once |
| `DELETE /blacklist/domains/:domain` | mutation | Remove domain, SIGHUP reload                                                                                   |

- API is **stateless, on-request**: reads the mounted log file and squashes per call
  (no resident tailer, no persistence). A shipper + persistent store is the optional step-2
  extension; it does not change the interface.
- Blacklist state stays in the host-mounted file (existing SIGHUP mechanism); the API is a thin writer over it - no second source of truth.
- The API owns parse/squash/blacklist-write logic internally: a deep module behind a small interface.

## UI / BFF integration (ADR-0010 extension)

- serve BFF proxies `/api/egress/*` to the egress API - same pattern as the existing `/api/runs/*` proxy.
- UI: list squashed entries, select one, click "Block" → forwards DELETE-less POST to BFF → egress API → immediate accept.
- UI stays observer-first; the single mutation it carries is blacklist write.

**ADR status**: ADR-0010 amended (exception to observer-first read-only, sole delegated mutation, `/api/egress/*` namespace). ADR-0012 records the egress query + mutation API surface (supersedes the planned ADR-0011 extension).

## Implementation Steps

1. `e-egress` Dockerfile/entrypoint: add the API listener (logs query + blacklist write + SIGHUP trigger).
2. Squash logic on the egress API ingest path.
3. serve BFF: `/api/egress/*` proxy.
4. UI: egress section - squashed entries list + Block action.
5. ADR-0012 already records the egress API surface (query + blacklist mutation).
