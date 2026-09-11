# 06 — Broker HTTP endpoint and depth/cap enforcement

**What to build:** The runtime-broker from #1 wires its HTTP surface: `POST /spawn` accepts a sibling request, assigns a sibling branch, enforces depth ≤ 2 (children may request siblings, never children of children) and concurrency cap ≤ 3 (default, configurable), returns run identity; readiness follows existing `SidecarOrchestrator` policy.

**Blocked by:** 02 — runtime-broker sidecar image and spawn-brother skill.

**Status:** blocked

- [ ] `POST /spawn {agent, prompt}` creates sibling run; response includes run identity
- [ ] Requests exceeding depth 2 rejected with error report to caller
- [ ] Requests exceeding concurrency cap rejected until a slot frees
- [ ] Readiness uses existing `SidecarOrchestrator` probe policy (ADR-0005 mirror)
- [ ] Tests cover depth rejection, cap rejection, successful spawn, readiness timeout
