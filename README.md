# Monorepo Structure

This repo is an npm workspaces monorepo. The `e` command's web UI ships inside
the CLI binary, so it lives in the CLI package, built straight into the
directory the CLI serves and pkg embeds.

## Projects

- `packages/cli` - the `e` Command Line Interface (Node.js, Commander.js). Owns
  the web UI (`packages/cli/ui`, a React app) and packages the `e` binary via
  `pkg`.
- `packages/docker` - Docker projects (stub).

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Build the CLI (UI bundle + TypeScript + native binaries):

```bash
npm run build --workspace @e/cli
```

Everything the binary needs - including the UI, served by `e serve` from
`dist/ui` and embedded by pkg - is produced by this one command.

3. Run tests:

```bash
npm run test --workspace @e/cli
```

4. Local development without packaging binaries:

```bash
npm run build:dev --workspace @e/cli   # UI + TypeScript into packages/cli/dist
npm run link --workspace @e/cli        # ...plus npm link, putting `e` on PATH
```

## Package Structure

- `packages/cli/ui` - React front-end (webpack entry). Its build output is
  `packages/cli/dist/ui`, which `e serve` reads and `pkg.assets` embeds in each
  standalone binary.
- `packages/cli/src` - the Node CLI (`e` commands: init, spawn, serve).

Each project has its own package.json and can be developed independently.
