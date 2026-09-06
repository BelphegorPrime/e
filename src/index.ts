#!/usr/bin/env node

import { Command } from 'commander';
import { registerSpawnCommand } from './spawn/spawn';
import { registerInitCommand } from './init/index';
import { registerServeCommand } from './serve/serve';
const program = new Command();

program
  .name('e')
  .description('CLI tool for my AI Orchestrator')
  .version('1.0.0');

registerSpawnCommand(program);
registerInitCommand(program);
registerServeCommand(program);

program.parse();
