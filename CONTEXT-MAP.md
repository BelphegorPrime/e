# Context Map

`e` is a monorepo. Each workspace package is its own context; this map lists them and how they relate.

## Contexts

- [CLI](./packages/cli/CONTEXT.md) - builds and runs coding-agent harnesses in containers (the `e` command). Owns the web UI front-end too: the React app lives under `packages/cli/ui/` and is built by webpack straight into `packages/cli/dist/ui`, which `e serve` reads and pkg embeds in the binary.
- **Docker** (`packages/docker`) — container build scaffolding. Stub today; no `CONTEXT.md` yet.

## Linting

- [Code Quality](./docs/agents/linting.md) — ESLint and Prettier configuration for consistent code quality and formatting.

## Relationships

- **UI → CLI**: the UI is intended to drive and observe CLI runs and ships inside the CLI binary (`packages/cli/ui`, bundled to `dist/ui`). The contract between them is undecided (see the UI ↔ backend design tree, not yet grilled).
