# Planning tickets

Work items live as GitHub issues in `BelphegorPrime/e` (see
`docs/agents/issue-tracker.md`). This directory holds the longer planning
write-ups behind some of them, kept in the repo because they are referenced
from ADRs:

| File                                           | Status                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `01` (env injection: `E_ROLE`, `E_BROKER_URL`) | Done (2026-09-12). The role contract; see the ticket's top.                                                |
| `02` (broker sidecar + `spawn-brother` skill)  | Done (2026-09-12). Broker spools requests; no socket. See the ticket's top.                                |
| `03` (host Git merge primitive)                | Done (2026-09-12). `Git.merge` with `merged` / `up-to-date` / `conflict` outcome.                          |
| `04` (checkpoint commit on spawn)              | Done (2026-09-12). `runSpawn` with a `parent` checkpoints it and branches from the tip.                    |
| `05` (artifact sync into children)             | Done (2026-09-12). Scratch copy + bind mount at `/workspace/<entry>`; `siblingArtifacts` config.           |
| `06` (host side of sibling requests)           | Done (2026-09-12). Consumer launches `e spawn` children; depth 403 / cap 429; `maxSiblings` config.        |
| `07`-`08` (merge-back, end-to-end test)        | Open. Design in ADR-0013 (Proposed); a sibling's work stays on its branch until 07 merges it back.         |
| `09` (spool read tolerance)                    | Open. Found while e2e-testing 08: a malformed status file crashes the host poll loop.                      |
| `10` (test sleep yields)                       | Open. Found while e2e-testing 08: the no-op test sleep starved the event loop and hung a real-broker test. |
| `11` (request id error)                        | Open. Found while e2e-testing 08: the id-format error gives no hint about the required shape.              |

When a ticket ships, add a status line at its top rather than deleting it.
