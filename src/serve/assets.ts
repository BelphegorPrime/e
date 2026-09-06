import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolves the bundled UI directory. The UI is built by webpack straight into
 * `dist/ui` (see ui/webpack.config.js) and embedded into the packaged binary by
 * pkg (pkg.assets), so a missing bundle means the build steps were skipped (not
 * that the path is wrong).
 */
export function resolveUiDirectory(
  entryDirectory = path.dirname(process.argv[1] ?? process.cwd())
): string {
  const uiDirectory = path.join(entryDirectory, 'ui');
  if (!fs.existsSync(path.join(uiDirectory, 'index.html'))) {
    throw new Error(
      `UI assets are missing at ${uiDirectory}. Run "npm run build:ui" from the repo root to build them (a packaged binary was built without them; reinstall it).`
    );
  }
  return uiDirectory;
}
