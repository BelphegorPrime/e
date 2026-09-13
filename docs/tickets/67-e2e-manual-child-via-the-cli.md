# 67 - E2E: manual child via the CLI

**Status:** Open, ready-for-agent.
**GitHub:** Pending - will mirror the created issue.

The manual-child design's core claim - "a host-written request equals a
broker request" - has no real-git proof. This ticket lifts the fixtures
the existing sibling round-trip e2e already uses (live Parent run with its
runtime-broker and spool, host git engine) so they can be reused, then
proves the CLI path: `e spawn --parent <branch> "<prompt>"` writes a
request into the parent's spool, the parent's running `SiblingConsumer`
launches the child, the child runs against the checkpointed parent
worktree, exits, its branch merges back as a merge commit, and the report
lands at `e-runs/<id>/report.md`.

**Blocked by:** None - can start immediately.

- [ ] Shared fixtures are lifted out of the existing e2e so the broker-sibling test and this one compose without duplication.
- [ ] The CLI path round trip completes on real git: request written, child launched, merged back, report present.
- [ ] The child ran as depth two: it carries the child role markers and its own requests would route through the parent's broker.
- [ ] The e2e asserts the parent's worktree actually received the child's committed changes.
