# Planning tickets

Work items live as GitHub issues in `BelphegorPrime/e` (see
`docs/agents/issue-tracker.md`). This directory holds the longer planning
write-ups behind some of them, kept in the repo because they are referenced
from ADRs:

| File                                           | Status                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `01` (env injection: `E_ROLE`, `E_BROKER_URL`) | Done (2026-09-12). The role contract; see the ticket's top.                                     |
| `02` (broker sidecar + `spawn-brother` skill)  | Done (2026-09-12). Broker spools requests; no socket. See the ticket's top.                     |
| `03` (host Git merge primitive)                | Done (2026-09-12). `Git.merge` with `merged` / `up-to-date` / `conflict` outcome.               |
| `04` (checkpoint commit on spawn)              | Done (2026-09-12). `runSpawn` with a `parent` checkpoints it and branches from the tip.         |
| `05`-`08` (nested spawn via runtime-broker)    | Open. Design in ADR-0013 (Proposed); the host side that executes sibling requests is not built. |

When a ticket ships, add a status line at its top rather than deleting it.
