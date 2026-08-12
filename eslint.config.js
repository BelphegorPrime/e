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
      },
    },
  },
  {
    rules: {
      'no-console': 'warn',
      'no-debugger': 'warn',
      'no-unused-vars': 'error',
      'no-undef': 'error',
    },
  }
);
