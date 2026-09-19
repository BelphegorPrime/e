#!/usr/bin/env node

import { Command } from 'commander';
import { registerSpawnCommand } from './cli/spawn.js';
import { registerInitCommand } from './cli/init/index.js';
import { registerServeCommand } from './cli/serve/serve.js';
import { registerRuntimeCommands } from './cli/runtime.js';
import {
  registerExportCommand,
  registerImportCommand,
} from './cli/transfer/index.js';
import { registerCompletion } from './cli/completion/index.js';
import { registerLintCommand } from './cli/lint/index.js';
import { registerTriggerCommands } from './cli/trigger/index.js';
import { E_VERSION } from './shared/version.js';

const program = new Command();

program
  .name('e')
  .description('CLI tool for my AI Orchestrator')
  .version(E_VERSION)
  .option('-v, --verbose', 'enable verbose logging', false)
  .hook('preAction', thisCommand => {
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
registerTriggerCommands(program);

// {@link registerCompletion} has to be the last thing to register before parse
registerCompletion(program);

program.parse();
