# Linting Setup

This project uses ESLint and Prettier for code quality and formatting consistency across all packages.

## Global Configuration

ESLint and Prettier are configured with global settings in the root directory:

- `.eslintrc.js`: Global ESLint configuration
- `.prettierrc`: Global Prettier configuration

## Package-specific Configuration

Each package extends the global configuration:

- `packages/cli/.eslintrc.js`
- `packages/ui/.eslintrc.js`

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
