/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-disable no-undef */
const eslintRecommended = require('@eslint/js');
const tseslint = require('typescript-eslint');

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
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        fetch: 'readonly',
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
