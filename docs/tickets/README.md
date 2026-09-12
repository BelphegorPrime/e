# Planning tickets

Work items live as GitHub issues in `BelphegorPrime/e` (see
`docs/agents/issue-tracker.md`). This directory holds the longer planning
write-ups behind some of them, kept in the repo because they are referenced
from ADRs:

| File                                           | Status                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `01` (env injection: `E_ROLE`, `E_BROKER_URL`) | Done (2026-09-12). The role contract; see the ticket's top.          |
| `02`-`08` (nested spawn via runtime-broker)    | Open. Design in ADR-0013 (Proposed); the broker itself is not built. |

When a ticket ships, add a status line at its top rather than deleting it.
