import type { Command } from 'commander';
import { exportConfiguration } from './export.js';
import { importConfiguration } from './import.js';
import { log } from '../utils/log.js';
import { findRoot } from '../store/root.js';

export function registerExportCommand(program: Command): void {
  program
    .command('export')
    .description('Export omniroute configuration and .e state to a zip file')
    .option(
      '-o, --output <path>',
      'output zip file path (default: .e/e-export-TIMESTAMP.zip)'
    )
    .action(async options => {
      try {
        const outputPath = await exportConfiguration(options);
        log.info(`✓ Configuration exported to: ${outputPath}`);
      } catch (error) {
        log.error(
          `Export failed: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(1);
      }
    });
}

export function registerImportCommand(program: Command): void {
  program
    .command('import')
    .description('Import omniroute configuration and .e state from a zip file')
    .argument('<file>', 'path to the zip file to import')
    .option(
      '--dir <path>',
      'root directory to import the configuration into (default: the nearest .e store above the current directory)'
    )
    .option(
      '-f, --force',
      'overwrite existing configuration without prompting',
      false
    )
    .action(async (file: string, options) => {
      try {
        // `--dir` wins; otherwise discover the nearest initialized `.e` store
        // (walking up from cwd, falling back to home).
        const root = findRoot(options.dir);

        await importConfiguration({ file, ...options, root });

        log.info('✓ Configuration imported successfully');
      } catch (error) {
        log.error(
          `Import failed: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(1);
      }
    });
}
