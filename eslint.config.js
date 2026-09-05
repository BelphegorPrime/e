/* eslint-disable @typescript-eslint/no-require-imports */
const eslintRecommended = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');

module.exports = tseslint.config(
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
    ],
  },
  {
    languageOptions: {
      globals: {
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
    files: ['packages/ui/**/*.{js,cjs,mjs,ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        // UMD global exposed by @types/react for the classic runtime
        React: 'readonly',
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

      'no-undef': 'error',
    },
  }
);
