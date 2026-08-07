# Context Map

`e` is a monorepo. Each workspace package is its own context; this map lists them and how they relate.

## Contexts

- [CLI](./packages/cli/CONTEXT.md) — builds and runs coding-agent harnesses in containers (the `e` command).
- **UI** (`packages/ui`) — front-end for the orchestrator. Stub today; no `CONTEXT.md` until its language firms up.
- **Docker** (`packages/docker`) — container build scaffolding. Stub today; no `CONTEXT.md` yet.

## Relationships

- **UI → CLI**: the UI is intended to drive and observe CLI runs. The contract between them is undecided — see the UI ↔ backend design tree, not yet grilled.
