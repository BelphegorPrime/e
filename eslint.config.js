import eslintRecommended from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  eslintRecommended.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      'node_modules/',
      'dist/',
      '.git/',
      '**/node_modules/',
      '**/dist/',
      '**/.git/',
      // Local e state and packaged binaries are not source.
      '.e/',
      'command/',
      // Agent worktrees are whole checkouts nested inside this one; linting
      // them lints the repo three more times and reports their errors as ours.
      '.claude/worktrees/',
      '**/.claude/worktrees/',
      'src/sidecars/egress/bundle.generated.ts',
      'src/sidecars/broker/bundle.generated.ts',
    ],
  },
  {
    languageOptions: {
      globals: {
        ...globals.node,
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        fetch: 'readonly',
        // Node 18+ / 24 runtime globals used in fetch mocking and tests
        Response: 'readonly',
        Request: 'readonly',
        URL: 'readonly',
        AbortSignal: 'readonly',
        // CommonJS globals (.cjs skill templates)
        module: 'readonly',
        require: 'readonly',
      },
    },
  },
  {
    files: ['ui/**/*.{js,cjs,mjs,ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  // ---------------------------------------------------------------------
  // Layer boundaries (see README, "Source layout"). `src/` is a DAG:
  //
  //   shared -> sidecars -> core -> ports -> engine -> cli -> index.ts
  //
  // A layer may import anything below it and nothing above it. Each block
  // below names the layers that are ABOVE the files it applies to, so an
  // upward import fails the build instead of quietly reintroducing a cycle.
  //
  // Exempt: `src/index.ts` (the composition root, which wires every layer) and
  // test files (an integration test may stand up the whole stack - e.g. the
  // A2A interop test drives `cli/serve`).
  // ---------------------------------------------------------------------
  ...[
    { dir: 'shared', above: ['sidecars', 'core', 'ports', 'engine', 'cli'] },
    { dir: 'sidecars', above: ['core', 'ports', 'engine', 'cli'] },
    { dir: 'core', above: ['ports', 'engine', 'cli'] },
    { dir: 'ports', above: ['engine', 'cli'] },
    { dir: 'engine', above: ['cli'] },
  ].map(({ dir, above }) => ({
    files: [`src/${dir}/**/*.ts`],
    ignores: ['**/*.test.ts', '**/*.testSupport.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: above.map(up => ({
            group: [`**/${up}/**`],
            message: `Layer violation: src/${dir} may not import from src/${up} (allowed direction: shared -> sidecars -> core -> ports -> engine -> cli).`,
          })),
        },
      ],
    },
  })),
  {
    rules: {
      'no-console': 'off',
      'no-debugger': 'warn',

      // Use TypeScript-aware version instead
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // The UI smoke test's page probes run inside Chrome (page.evaluate).
    files: ['scripts/smoke-ui/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    // Undefined identifiers in TypeScript are a tsc error already; the ESLint
    // rule only produces false positives on type names there.
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      'no-undef': 'error',
    },
  }
);
