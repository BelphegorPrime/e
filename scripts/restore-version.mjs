import fs from 'node:fs/promises';

await fs.writeFile('src/version.ts', `export const E_VERSION = '1.0.0';\n`);
