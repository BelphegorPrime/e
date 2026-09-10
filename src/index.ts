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
  .version(E_VERSION)
  .option('-v, --verbose', 'enable verbose logging', false)
  .hook('preAction', (thisCommand) => {
    if (thisCommand.opts().verbose) {
      process.env.VERBOSE = 'true';
    }
  });

registerSpawnCommand(program);
registerInitCommand(program);
registerServeCommand(program);
registerRuntimeCommands(program);
registerExportCommand(program);
registerImportCommand(program);
registerLintCommand(program);

// {@link registerCompletion} has to be the last thing to register before parse
registerCompletion(program);

program.parse();
