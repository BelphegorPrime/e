# 11 - Request id format is validated with an unhelpful error

**Root cause found 2026-09-12 while building the ticket 08 end-to-end test:** a
spool write with id `gc-001` failed with `Invalid request id "gc-001".` and no
hint about the required shape. The broker generates ids itself
(`sib-001`, `sib-002`, ...), so only direct spool writers see the error - a
scripted child in a test, an operator poking the spool, a tool calling the
spool helpers - and none of them can guess the format from the message.

**What to build:** the request-id check is a documented contract with a
self-explaining error. The validator stays canonical (one place, `sib-\d{3}`
form), the error names the expected format with an example, and the constant
is documented at the check site.

**Blocked by:** None - can start immediately.

**Status:** ready-for-agent

- [ ] `Invalid request id` error names the required shape (`sib-001`, ...)
- [ ] The format has one canonical definition (constant or doc comment) used
      by validator, id generator, and error message
- [ ] Test asserting the improved error message for a non-conforming id
