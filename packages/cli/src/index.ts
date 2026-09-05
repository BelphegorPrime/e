#!/usr/bin/env node

import { Command } from 'commander';
import { registerSpawnCommand } from './spawn';
import { registerInitCommand } from './init';
import { registerServeCommand } from './serve';
const program = new Command();

program
  .name('e')
  .description('CLI tool for my AI Orchestrator')
  .version('1.0.0');

registerSpawnCommand(program);
registerInitCommand(program);
registerServeCommand(program);

program.parse();
