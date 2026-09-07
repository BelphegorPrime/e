#!/usr/bin/env node

import { Command } from 'commander';
import { registerSpawnCommand } from './spawn/spawn.js';
import { registerInitCommand } from './init/index.js';
import { registerServeCommand } from './serve/serve.js';
import {
  registerExportCommand,
  registerImportCommand,
} from './transfer/index.js';
import { log } from './utils/log.js';

const program = new Command();

const getVersion = async (): Promise<string> => {
  const versionModule = './version.js';
  let version = '1.0.0';
  try {
    const mod = await import(versionModule);
    version = mod.E_VERSION;
  } catch {
    log.info('version.ts/version.js does not exist');
  }
  return version;
};

program
  .name('e')
  .description('CLI tool for my AI Orchestrator')
  .version(await getVersion());

registerSpawnCommand(program);
registerInitCommand(program);
registerServeCommand(program);
registerExportCommand(program);
registerImportCommand(program);

program.parse();
