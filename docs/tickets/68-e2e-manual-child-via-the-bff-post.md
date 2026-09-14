# 68 - E2E: manual child via the BFF POST

**Status:** Open, ready-for-agent.
**GitHub:** Pending - will mirror the created issue.

The second Manual child trigger surface - the BFF
`POST /api/runs/<branch>/siblings` route - has no real-git proof either.
Building on ticket 67's lifted fixtures, this ticket runs the same round
trip through the HTTP route: a POST with agent and prompt against a live
Parent run writes the same spool request, the parent's `SiblingConsumer`
launches and merges it back, and the response's accepted shape matches
what the CLI's path returns. The two surfaces must produce byte-equivalent
requests in the spool.

**Blocked by:** 67 (shared e2e fixtures).

- [ ] The POST round trip completes on real git with the same merge-back and report assertions as the CLI path.
- [ ] The spooled request from the BFF POST is identical in shape to the CLI's (same id format, agent, prompt, timestamp).
- [ ] The accepted response matches the CLI's accepted JSON shape.
