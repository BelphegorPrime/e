# 09 - Host poll loop survives a malformed status file

**Root cause found 2026-09-12 while building the ticket 08 end-to-end test:** a
scripted child writing its status non-atomically put a truncated
`status/<id>.json` on the spool; the host's polling side crashed instead of
ignoring it. Production writers all go through the atomic spool helpers
(tmp + rename), so this is latent today, but nothing enforces that, and one
misbehaving writer - a future child `e spawn` path, an operator, a test -
kills sibling handling for the whole run.

**What to build:** the host's spool reads never throw on a malformed file. A
truncated or corrupt `status/<id>.json` (or request/run-info file) is skipped
and treated as absent for that poll; the consumer and broker keep serving
every other request, and the next poll retries. No behavioral change for valid
files.

**Blocked by:** None - can start immediately.

**Status:** ready-for-agent

- [ ] Polling a spool with a corrupt status file returns "no status" instead of throwing
- [ ] The sibling consumer's tick keeps servicing other requests after one malformed file
- [ ] Regression test: write a half-written status file (raw write, no rename),
      tick the consumer, assert the loop survives and other requests proceed
- [ ] Healthy-file behavior unchanged (existing spool tests pass)
