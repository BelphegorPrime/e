import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import AdmZip from 'adm-zip';
import {
  eBaseDir,
  envFilePath,
  configFilePath,
  dockerComposePath,
  bootstrapScriptPath,
} from '../store/paths.js';
import { log } from '../utils/log.js';
import { OMNIROUTE_VOLUME } from '../constants.js';

const execAsync = promisify(exec);

export interface ImportOptions {
  file: string;
  root?: string;
  force?: boolean;
}

/**
 * Import omniroute configuration and .e state from a zip file.
 * Restores:
 * - .env secrets
 * - config.json
 * - compose.yaml
 * - bootstrap.sh
 * - omniroute-data volume contents
 */
export async function importConfiguration(
  options: ImportOptions
): Promise<void> {
  const { file: zipPath, root, force = false } = options;
  const baseDir = eBaseDir(root);

  if (!fs.existsSync(zipPath)) {
    throw new Error(`Import file not found: ${zipPath}`);
  }

  log.info(`Starting configuration import from: ${zipPath}`);

  // Check if .e already has content
  const envPath = envFilePath(root);
  const configPath = configFilePath(root);
  if (!force && (fs.existsSync(envPath) || fs.existsSync(configPath))) {
    throw new Error(
      'Configuration already exists. Use --force to overwrite, or export current config first.'
    );
  }

  // If force is enabled, we should remove existing files before importing
  if (force) {
    if (fs.existsSync(envPath)) {
      fs.unlinkSync(envPath);
      log.debug('Removed existing .env file');
    }
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
      log.debug('Removed existing config.json file');
    }
  }

  // Create temp dir for extraction
  const tempDir = path.join(baseDir, '.import-temp');
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // Extract zip
    log.debug('Extracting archive...');
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(tempDir, true);

    // Restore .e files
    const filesToRestore = [
      { arcPath: '.env', targetPath: envPath },
      { arcPath: 'config.json', targetPath: configPath },
      { arcPath: 'compose.yaml', targetPath: dockerComposePath(root) },
      { arcPath: 'bootstrap.sh', targetPath: bootstrapScriptPath(root) },
    ];

    fs.mkdirSync(baseDir, { recursive: true });

    for (const file of filesToRestore) {
      const sourcePath = path.join(tempDir, file.arcPath);
      if (fs.existsSync(sourcePath)) {
        log.debug(`Restoring ${file.arcPath}...`);
        fs.copyFileSync(sourcePath, file.targetPath);
      } else {
        log.debug(`Missing in archive: ${file.arcPath}`);
      }
    }

    // Restore volume data
    const volumeDataDir = path.join(tempDir, 'omniroute-data');
    if (fs.existsSync(volumeDataDir)) {
      log.debug('Restoring omniroute volume...');

      // Check if volume exists; create if not
      try {
        await execAsync(`docker volume inspect ${OMNIROUTE_VOLUME}`);
        log.debug(`Volume ${OMNIROUTE_VOLUME} exists, will overwrite...`);
      } catch {
        log.debug(`Creating volume ${OMNIROUTE_VOLUME}...`);
        await execAsync(`docker volume create ${OMNIROUTE_VOLUME}`);
      }

      // Copy data into volume via temp container
      await execAsync(
        `docker run --rm -v "${volumeDataDir}:/source" -v ${OMNIROUTE_VOLUME}:/dest alpine sh -c "rm -rf /dest/* /dest/..?* /dest/.[!.]* 2>/dev/null || true && cp -a /source/. /dest/"`
      );

      log.info('Volume data restored.');
    } else {
      log.warn('No omniroute-data found in archive.');
    }

    log.info('Import complete. Run docker compose to start services.');
  } finally {
    // Cleanup temp dir
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
