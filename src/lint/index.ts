import { Command } from 'commander';
import { log } from '../utils/log.js';
import { writeIfAbsent } from '../scaffold.js';
import { spawnSync } from 'child_process';
import path from 'path';

export function registerLintCommand(program: Command): void {
  program
    .command('lint')
    .description('Initialize linting and formatting gates')
    .action(async () => {
      await runLintInit();
    });
}

async function runLintInit(): Promise<void> {
  // 1. Ensure prek
  if (spawnSync('prek', ['--version']).status !== 0) {
    log.error('prek not found in PATH. Install from https://prek.j178.dev/');
    process.exit(1);
  }

  // 2. Scaffold template
  const configContent = `
# Prek/pre-commit configuration
repos:
  - repo: local
    hooks:
      - id: prettier
        name: prettier
        entry: npx prettier --write
        language: system
        files: "\\.(js|ts|json|md|yaml)$"
`;
  writeIfAbsent(
    process.cwd(),
    path.join(process.cwd(), '.pre-commit-config.yaml'),
    configContent
  );

  // 3. Wire hooks
  const result = spawnSync('prek', ['install'], { stdio: 'inherit' });
  if (result.status !== 0) {
    log.error('Failed to install hooks');
    process.exit(1);
  }
  log.success('Linting gates initialized');
}
