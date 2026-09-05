module.exports = [
  {
    files: ['**/*.ts'],
    extends: ['../../eslint.config.js'],
    parserOptions: {
      project: './tsconfig.json',
    },
    rules: {
      // Package-specific rules can be added here
    },
  },
];
