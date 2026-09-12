import fs from 'fs';
import path from 'path';
import { ZipArchive } from 'archiver';
import {
  eBaseDir,
  envFilePath,
  configFilePath,
  dockerComposePath,
  bootstrapScriptPath,
} from '../store/paths.js';
import { findRoot } from '../store/root.js';
import { log } from '../utils/log.js';
import type { ContainerRunner } from '../runtime/index.js';
import { resolveRuntime } from '../runtime/registry.js';
import { OMNIROUTE_VOLUME } from '../constants.js';

export interface ExportOptions {
  output?: string;
  root?: string;
  /**
   * Runtime used for the volume operations; defaults to the resolved
   * production runtime (and is injected by tests as a recording fake).
   */
  runner?: ContainerRunner;
}

/**
 * Export omniroute configuration and .e state to a portable zip file.
 * Includes:
 * - .env secrets (OMNIROUTE_INITIAL_PASSWORD, JWT_SECRET, API_KEY_SECRET)
 * - config.json (default harness, models, git platform)
 * - compose.yaml (stack definition)
 * - bootstrap.sh (bootstrap script)
 * - omniroute-data volume contents (omniroute state/config)
 */
export async function exportConfiguration(
  options: ExportOptions = {}
): Promise<string> {
  // Discover the nearest initialized `.e` store when no root was supplied.
  // Passing undefined directly to the path helpers would incorrectly default
  // every path to the user's home directory.
  const root = findRoot(options.root);
  const baseDir = eBaseDir(root);
  // `--runtime`/`E_RUNTIME`/auto-detect, like `e spawn` (never hardcoded docker).
  const runner = options.runner ?? resolveRuntime();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const defaultOutput = path.join(baseDir, `e-export-${timestamp}.zip`);
  const outputPath = options.output ?? defaultOutput;

  log.info('Starting configuration export...');

  // Check volume exists
  if (!runner.volumeExists(OMNIROUTE_VOLUME)) {
    throw new Error(
      `Docker volume ${OMNIROUTE_VOLUME} not found. Run 'docker compose -f ${dockerComposePath(root)} up -d' first.`
    );
  }

  // Create temp dir for volume export
  const tempDir = path.join(baseDir, '.export-temp');
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // Export volume data via temporary container
    log.info('Exporting omniroute volume...');
    const volumeExportDir = path.join(tempDir, 'omniroute-data');
    fs.mkdirSync(volumeExportDir, { recursive: true });

    // Create temp container to access volume
    runner.copyVolumeToDir(OMNIROUTE_VOLUME, volumeExportDir);

    // Create zip archive
    log.info(`Creating archive: ${outputPath}`);
    const output = fs.createWriteStream(outputPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    await new Promise<void>((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);

      archive.pipe(output);

      // Add .e files
      const filesToExport = [
        { path: envFilePath(root), arcPath: '.env' },
        { path: configFilePath(root), arcPath: 'config.json' },
        { path: dockerComposePath(root), arcPath: 'compose.yaml' },
        { path: bootstrapScriptPath(root), arcPath: 'bootstrap.sh' },
      ];

      for (const file of filesToExport) {
        if (fs.existsSync(file.path)) {
          archive.file(file.path, { name: file.arcPath });
        } else {
          log.warn(`Skipping missing file: ${file.arcPath}`);
        }
      }

      // Add volume data
      archive.directory(volumeExportDir, 'omniroute-data');

      archive.finalize();
    });

    const stats = fs.statSync(outputPath);
    log.info(
      `Export complete: ${outputPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`
    );

    return outputPath;
  } finally {
    // Cleanup temp dir
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
