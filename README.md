# Monorepo Structure

This is a monorepo containing multiple subprojects:

## Projects

- `packages/ui` - User Interface project (React-based)
- `packages/cli` - Command Line Interface tool (Node.js-based) - Includes binary building capabilities
- `packages/docker` - Docker projects

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Run development servers:

```bash
npm run dev
```

3. Build all projects:

```bash
npm run build
```

4. Run tests:

```bash
npm run test
```

5. Clean all node_modules:

```bash
npm run clean
```

## Package Management

This monorepo uses npm workspaces to manage multiple packages.

## Project Structure

- `packages/ui` - Contains UI application with React
- `packages/cli` - Contains CLI tool using Commander.js
- `packages/docker` - Contains Docker configuration and Dockerfile

Each subproject has its own package.json and can be developed independently.
