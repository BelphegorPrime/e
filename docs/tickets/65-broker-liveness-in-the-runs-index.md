# 65 - Broker liveness in the runs index

**Status:** Open, ready-for-agent.
**GitHub:** Pending - will mirror the created issue.

The BFF's `/api/runs` index is branch-backed (ADR-0010) and says nothing
about whether a run is live with a runtime-broker, so a client cannot tell
which runs can take a Manual child without probing the per-run siblings
view. This ticket adds the live-broker state to the index entry: present
when the run's broker spool carries `run.json` naming role `parent`,
absent otherwise. The data comes from the same spool read the siblings
view already does, so no new trust boundary and no container is involved.

**Blocked by:** None - can start immediately.

- [ ] Each `/api/runs` index entry carries the run's live-broker state, true only for a spool with `run.json` naming role `parent`.
- [ ] A run without a spool, or with a spool whose role is `child`, reports false - a Child run has no broker of its own.
- [ ] The producer is unit-tested through the API without an HTTP server, like the rest of the runs reader.
- [ ] The liveness is derived from the same spool read as the siblings view, so the two cannot disagree.
