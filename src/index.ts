#!/usr/bin/env node

import { Command } from 'commander';
import { registerSpawnCommand } from './spawn/spawn.js';
import { registerInitCommand } from './init/index.js';
import { registerServeCommand } from './serve/serve.js';
import { registerRuntimeCommands } from './runtime/command.js';
import {
  registerExportCommand,
  registerImportCommand,
} from './transfer/index.js';
import { registerCompletion } from './completion/index.js';
import { registerLintCommand } from './lint/index.js';
import { E_VERSION } from './version.js';

const program = new Command();

program
  .name('e')
  .description('CLI tool for my AI Orchestrator')
  .version(E_VERSION);

registerSpawnCommand(program);
registerInitCommand(program);
registerServeCommand(program);
registerRuntimeCommands(program);
registerExportCommand(program);
registerImportCommand(program);
registerLintCommand(program);
registerCompletion(program);

program.parse();
