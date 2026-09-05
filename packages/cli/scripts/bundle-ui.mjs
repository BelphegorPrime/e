// Bundles the @e/ui webpack build into the CLI distribution at dist/ui.
//
// Replaces the former shell one-liner (`rm -rf ./dist/ui && cp -R ../ui/dist/ui
// ./dist/ui`), which failed silently and copied junk when the UI build was
// stale, partial, or missing. This script owns the whole step as real code:
// it builds the UI, verifies the webpack output, copies it, re-verifies the
// copy hash-by-hash, and records what was shipped in `ui-manifest.json`. A
// fresh bundle is skipped unless `--force` is passed; `--no-build` copies an
// already-built UI without invoking npm.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MANIFEST_NAME = 'ui-manifest.json';

export const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const cliRoot = path.resolve(scriptDir, '..');
export const uiRoot = path.resolve(cliRoot, '..', 'ui');
export const uiBuildDir = path.join(uiRoot, 'dist', 'ui');
export const destDir = path.join(cliRoot, 'dist', 'ui');

/** sha256 of a file's bytes, hex. */
export function sha256(filePath) {
  return createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

/**
 * Verifies `dir` looks like a complete webpack UI build and returns a
 * manifest entry for it. Throws (with a direction, not a bare ENOENT)
 * when the output is missing or partial.
 */
export function verifyWebpackOutput(dir) {
  const indexHtml = path.join(dir, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    throw new Error(
      `UI build is missing ${indexHtml} (did "npm run build --workspace @e/ui" fail?)`
    );
  }
  const assetsDir = path.join(dir, 'assets');
  let assetNames = [];
  if (fs.existsSync(assetsDir)) {
    assetNames = fs
      .readdirSync(assetsDir)
      .filter(name => fs.statSync(path.join(assetsDir, name)).isFile());
  }
  if (assetNames.length === 0) {
    throw new Error(
      `UI build at ${dir} has no bundled assets under assets/ (empty or partial webpack output)`
    );
  }
  const files = [
    { path: 'index.html', sha256: sha256(indexHtml) },
    ...assetNames.map(name => ({
      path: path.join('assets', name),
      sha256: sha256(path.join(assetsDir, name)),
    })),
  ];
  return { builtAt: new Date().toISOString(), files };
}

/** Parses dist/ui/ui-manifest.json; null when absent or unreadable. */
export function readManifest(dir) {
  const manifestPath = path.join(dir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

export function writeManifest(dir, manifest) {
  fs.writeFileSync(
    path.join(dir, MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
}

/**
 * True when the copied bundle already matches the current UI build, byte for
 * byte. Same set of files with identical sha256s means no rebuild needed.
 */
export function isUiFresh(sourceDir, destDir) {
  try {
    const sourceManifest = verifyWebpackOutput(sourceDir);
    const destManifest = readManifest(destDir);
    if (!destManifest) {
      return false;
    }
    return (
      sourceManifest.files.length === destManifest.files.length &&
      sourceManifest.files.every((sourceFile, index) => {
        const destFile = destManifest.files[index];
        return (
          destFile &&
          destFile.path === sourceFile.path &&
          destFile.sha256 === sourceFile.sha256
        );
      })
    );
  } catch {
    return false;
  }
}

/**
 * Copies a verified UI build into `destDir`, wiping any previous copy first.
 * Every copied file is re-hashed and compared against the source; a mismatch
 * throws instead of leaving a silently-corrupt bundle behind.
 */
export function copyUiAssets(sourceDir, destDir) {
  const sourceResolved = path.resolve(sourceDir);
  const destResolved = path.resolve(destDir);
  if (destResolved === sourceResolved) {
    throw new Error(
      `Refusing to copy the UI build onto itself: ${destResolved}`
    );
  }
  if (destResolved === path.parse(destResolved).root) {
    throw new Error(`Refusing to wipe the filesystem root as UI dest: ${destResolved}`);
  }
  if (destResolved === os.homedir()) {
    throw new Error(`Refusing to wipe the home directory as UI dest: ${destResolved}`);
  }
  const sourceManifest = verifyWebpackOutput(sourceDir);
  fs.rmSync(destResolved, { recursive: true, force: true });
  fs.mkdirSync(destResolved, { recursive: true });
  fs.cpSync(sourceDir, destResolved, { recursive: true });
  const copiedManifest = verifyWebpackOutput(destResolved);
  for (const file of sourceManifest.files) {
    const copied = copiedManifest.files.find(entry => entry.path === file.path);
    if (!copied || copied.sha256 !== file.sha256) {
      throw new Error(
        `UI copy verification failed for ${file.path} (source ${file.sha256} vs ${copied?.sha256 ?? 'missing'})`
      );
    }
  }
  writeManifest(destResolved, sourceManifest);
  return sourceManifest.files.length;
}

/**
 * Builds the UI package. `npmPath` is the npm executable (or its cli.js when
 * running inside an npm script, via `npm_execpath`); output streams through so
 * webpack errors surface in the caller's terminal.
 */
export function buildUi({ npmPath = process.env.npm_execpath ?? 'npm' } = {}) {
  if (!fs.existsSync(path.join(uiRoot, 'package.json'))) {
    throw new Error(
      `UI package not found at ${uiRoot} (bundle scripts resolve relative to the CLI package, not the cwd)`
    );
  }
  const command = npmPath.endsWith('.js')
    ? [process.execPath, npmPath, 'run', 'build']
    : [npmPath, 'run', 'build'];
  const result = spawnSync(command[0], command.slice(1), {
    cwd: uiRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(
      `"npm run build" in ${uiRoot} failed (exit ${result.status ?? result.error?.message}). ` +
        'Run it manually to see the webpack error.'
    );
  }
}

/**
 * True when any file under the UI's src/ is newer than the webpack output
 * (index.html) — i.e. source was edited but never rebuilt. Catches the stale
 * silent-copy case the old shell script shipped blindly.
 */
export function isUiSourceStale(
  sourceRoot = uiRoot,
  buildDirArg = uiBuildDir
) {
  const srcDir = path.join(sourceRoot, 'src');
  if (!fs.existsSync(srcDir)) {
    return false;
  }
  const indexHtml = path.join(buildDirArg, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    return true;
  }
  const buildStamp = fs.statSync(indexHtml).mtimeMs;
  let latest = 0;
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else {
        latest = Math.max(latest, fs.statSync(entryPath).mtimeMs);
      }
    }
  };
  walk(srcDir);
  return latest > buildStamp;
}

/**
 * Full bundle pipeline. Builds the UI (unless build is false or the current
 * source already matches the previous bundle), then copies and verifies it
 * into dist/ui.
 */
export function bundleUi({ build = true, force = false } = {}) {
  const sourceExists = fs.existsSync(uiBuildDir);
  const sourceDirty = sourceExists ? isUiSourceStale() : true;
  const needsBuild =
    build && (force || !sourceExists || (sourceDirty && !isUiFresh(uiBuildDir, destDir)));
  if (needsBuild) {
    buildUi();
  }
  const upToDate =
    !force && sourceExists && !sourceDirty && isUiFresh(uiBuildDir, destDir);
  if (upToDate) {
    return { copied: false, files: readManifest(destDir)?.files.length ?? 0 };
  }
  const fileCount = copyUiAssets(uiBuildDir, destDir);
  return { copied: true, files: fileCount };
}

function usage() {
  console.log(`Usage: node scripts/bundle-ui.mjs [--force] [--no-build]

Bundles the @e/ui webpack build into dist/ui (verified copy + ui-manifest.json).

  --force     rebuild the UI and re-copy even when the bundle is up to date
  --no-build  copy an existing UI build without invoking npm`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }
  const force = args.includes('--force');
  const build = !args.includes('--no-build');
  try {
    const result = bundleUi({ build, force });
    console.log(
      result.copied
        ? `Bundled UI into ${destDir} (${result.files} verified files)`
        : `UI bundle up to date (${result.files} files); use --force to rebuild`
    );
  } catch (error) {
    console.error(`bundle:ui failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}