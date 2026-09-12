# 06 - Broker HTTP endpoint and depth/cap enforcement

**What to build:** The runtime-broker from #02 wires its HTTP surface: `POST /spawn` accepts a sibling request, assigns a sibling branch, enforces depth ≤ 2 (children may request siblings, never children of children) and concurrency cap ≤ 3 (default, configurable), returns run identity; readiness follows existing `SidecarOrchestrator` policy.

**Blocked by:** 02 shipped (2026-09-12): the HTTP surface (`POST /spawn` -> `202 {id}`, `GET /status`) and the spool exist; what remains here is the host side that consumes `requests/`, assigns the sibling branch, enforces depth and cap, and writes `status/`.

**Status:** blocked

- [ ] `POST /spawn {agent, prompt}` creates sibling run; response includes run identity
- [ ] Requests exceeding depth 2 rejected with error report to caller
- [ ] Requests exceeding concurrency cap rejected until a slot frees
- [ ] Readiness uses existing `SidecarOrchestrator` probe policy (ADR-0005 mirror)
- [ ] Tests cover depth rejection, cap rejection, successful spawn, readiness timeout
