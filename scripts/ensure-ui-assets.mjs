// Preflight gate for the pkg build (`prebuild:bin`): fails fast when the UI
// bundle is missing from dist/ui, so a packaged binary can never ship without
// its UI (the failure mode that made `e serve` crash at startup with "UI
// assets are missing at .../dist/ui").
//
// The UI is built straight into dist/ui by webpack (build:ui); `serve` reads
// it from there (src/serve/assets.ts) and pkg embeds it (pkg.assets). A missing
// index.html therefore means build:ui never ran (packaging anyway would
// produce a silently broken binary.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const cliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
export const uiAssetsDir = path.join(cliRoot, 'dist', 'ui');

/** Throws unless `dir` contains a built UI bundle; returns `dir` on success. */
export function ensureUiAssets(dir = uiAssetsDir) {
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    throw new Error(
      `UI assets are missing at ${dir}. Run "npm run build:ui" (from the repo root) before packaging the binary.`
    );
  }
  return dir;
}

function main() {
  try {
    ensureUiAssets();
    console.log(`UI assets present at ${uiAssetsDir}`);
  } catch (error) {
    console.error(
      `prebuild:bin failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
