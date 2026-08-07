#!/usr/bin/env node

import { Command } from 'commander';
const program = new Command();

program
  .name('e')
  .description('CLI tool for my AI Orchestrator')
  .version('1.0.0');

program
  .command('hello')
  .description('Say hello')
  .action(() => {
    console.log('Hello from the CLI!');
  });

program.parse();
