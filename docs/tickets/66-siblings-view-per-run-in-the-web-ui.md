# 66 - Siblings view per run in the web UI

**Status:** Open, ready-for-agent.
**GitHub:** Pending - will mirror the created issue.

The web UI's Runs page shows the run index only; there is no way to watch
a Parent run's children. This ticket adds a per-run siblings view that
reads the existing GET `/api/runs/<branch>/siblings` snapshot - the
sibling records with their task state - so a human can see what children a
live parent has and how each is progressing. A run without a broker shows
the "no siblings" state the endpoint already answers. Read-only: this
ticket is about seeing children, not starting them (ticket 69).

**Blocked by:** None - can start immediately.

- [ ] The Runs page offers a per-run view that renders the siblings snapshot from the BFF for a live broker parent.
- [ ] Task state is visible per sibling record (requested / working / completed / failed / input-required / canceled / rejected).
- [ ] A run whose spool is absent renders the no-siblings state without an error.
- [ ] The view uses the same BFF client convention as the rest of the UI (loading / error / ready states).
