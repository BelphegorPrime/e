import fs from 'node:fs';
import path from 'node:path';

export function resolveUiDirectory(
  entryDirectory = path.dirname(process.argv[1] ?? process.cwd())
): string {
  const uiDirectory = path.join(entryDirectory, 'ui');
  if (!fs.existsSync(path.join(uiDirectory, 'index.html'))) {
    throw new Error(
      `UI assets are missing at ${uiDirectory}. Build the UI before starting the server.`
    );
  }
  return uiDirectory;
}
