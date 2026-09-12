# 10 - Test sleep helper yields to the event loop

**Root cause found 2026-09-12 while building the ticket 08 end-to-end test:** a
test run with a real broker HTTP server hung indefinitely. The test-support
sleep helper resolves as a microtask with no timer, so the sibling consumer's
poll loop (`tick` then sleep, tight) starved the event loop and the parent's
`fetch` to the broker never completed. The hang only appears in tests that
combine the consumer with real I/O - the sibling cycled through the fake
launcher in older tests never needed it.

**What to build:** the shared test sleep helper yields (no-op microtask
promise keeps starving poll loops). The recorded-sleeps introspection tests
rely on stays intact; any test that runs the consumer alongside real network
I/O completes instead of hanging.

**Blocked by:** None - can start immediately.

**Status:** ready-for-agent

- [ ] The test sleep helper yields at least once per call (e.g. `setImmediate`)
      while still recording the requested duration
- [ ] A consumer driven by the helper completes network I/O in the same test
      (regression: broker HTTP request + consumer poll loop, no hang)
- [ ] Existing run-spawn/sibling tests that record sleeps still pass (recorded
      durations unchanged)
