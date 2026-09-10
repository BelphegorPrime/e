import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';

let commitHash;
try {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf-8',
  });
  const hash = result.stdout?.trim();
  if (!result.error && result.status === 0 && hash) {
    commitHash = hash;
  } else {
    console.error(
      `Failed to get commit hash: ${result.error ?? result.stderr}`
    );
  }
} catch (error) {
  console.error(`Failed to get commit hash: ${error}`);
}

console.log(commitHash);

try {
  const newData = `export const E_VERSION = '${commitHash ?? '1.0.0'}';\n`;
  await fs.writeFile('src/version.ts', newData);
} catch (err) {
  console.error(`Failed to read or write version file: ${err}`);
}
