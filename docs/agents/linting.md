# Linting Setup

This project uses ESLint and Prettier for code quality and formatting consistency across all packages.

## Global Configuration

ESLint and Prettier use flat configs at the root:

- `eslint.config.js`: flat ESLint config covering all packages
- `.prettierrc`: Global Prettier configuration

## Package-specific scopes

The root flat config applies globally and adds browser globals for the bundled
UI (which lives inside the CLI package now):

- `packages/cli/ui/**/*` gets `globals.browser` (the React front-end, built by
  webpack into `packages/cli/dist/ui`)
- `packages/cli/src/**` (the Node CLI) uses the global config

## Available Scripts

From the root directory, you can run:

```bash
# Lint all files
npm run lint

# Lint and fix issues automatically
npm run lint:fix

# Format all files with Prettier
npm run format

# Check formatting without modifying files
npm run format:check
```

## Configuration Details

### ESLint Rules

- Extends `eslint:recommended`
- Extends `plugin:@typescript-eslint/recommended`
- Uses TypeScript parser
- Warns on console.log and debugger statements
- Errors on unused variables and undefined variables

### Prettier Settings

- Uses semicolons
- Single quotes
- Trailing commas (es5)
- Print width: 80 characters
- Tab width: 2 spaces
- No tabs
- Bracket spacing: true
- Arrow parens: avoid
