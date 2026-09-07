#!/usr/bin/env node

import { Command } from 'commander';
import { registerSpawnCommand } from './spawn/spawn.js';
import { registerInitCommand } from './init/index.js';
import { registerServeCommand } from './serve/serve.js';
import {
  registerExportCommand,
  registerImportCommand,
} from './transfer/index.js';

const program = new Command();

const version = process.env.E_VERSION ?? '1.0.0';

program
  .name('e')
  .description('CLI tool for my AI Orchestrator')
  .version(version);

registerSpawnCommand(program);
registerInitCommand(program);
registerServeCommand(program);
registerExportCommand(program);
registerImportCommand(program);

program.parse();
