# Linting Setup

This project uses ESLint and Prettier for code quality and formatting consistency.

## Global Configuration

ESLint and Prettier use flat configs at the root:

- `eslint.config.js`: flat ESLint config
- `.prettierrc`: Prettier configuration

## Package-specific scopes

The root flat config applies globally and adds browser globals for the bundled
UI (which lives in the repo root now):

- `ui/**/*` gets `globals.browser` (the React front-end, built by
  webpack into `dist/ui`)
- `src/**` (the Node CLI) uses the global config

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
