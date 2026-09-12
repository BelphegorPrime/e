# 58 - Share the HTTP plumbing between the broker and egress sidecars

**Status:** Done (closed 2026-09-13), `6d0f9bb`.

**GitHub:** [#123](https://github.com/BelphegorPrime/e/issues/123)

---

**Found 2026-09-13 in an architecture review.** `src/sidecars/broker/` and `src/sidecars/egress/` look like twins in the file tree, but only their plumbing is twinned - the domains share nothing (spool/taskState/events/watch vs blacklist/domain/logParser/squash, 6 endpoints over a Spool vs 5 over a log file). Structural symmetry is ~90%; duplicated implementation is ~60 lines, all of it plumbing:

| helper                                   | broker      | egress      |
| ---------------------------------------- | ----------- | ----------- |
| `type Handler`                           | `api.ts:55` | `api.ts:47` |
| `MAX_BODY_BYTES` + `class BodyTooLarge`  | `:62-64`    | `:52-54`    |
| `readBody` (13 lines, byte-identical)    | `:82-95`    | `:83-96`    |
| `decodeSegment`                          | `:124-130`  | `:99-105`   |
| `sendJson` (only the union type differs) | `:66-80`    | `:69-81`    |
| the `.catch` tail                        | `:288-297`  | `:196-201`  |

The catch tails have **already diverged**: the broker maps `BodyTooLarge` to 413 in the tail; egress has no 413 branch there and instead catches it inline inside the POST handler at `:160-163`. Two copies, two answers to the same question.

**What to build:** one small `sidecars/http.ts` with the body reader, the JSON response, the segment decoder and the error-to-status tail. Leave the routing alone - the two route tables are genuinely different and should stay apart.

**Blocked by:** None. Small; good first ticket.

- [ ] One module owns `readBody`, `sendJson`, `decodeSegment` and the error tail
- [ ] Both sidecars return the same status for an oversized body, and a test pins it
- [ ] The bundled server output still builds (`npm run build:broker`, `npm run build:egress-api`)
- [ ] `rm -rf dist && npm test` green
