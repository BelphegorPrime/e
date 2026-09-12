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
      'src/egress/bundle.generated.ts',
      'src/broker/bundle.generated.ts',
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
    // Undefined identifiers in TypeScript are a tsc error already; the ESLint
    // rule only produces false positives on type names there.
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      'no-undef': 'error',
    },
  }
);
