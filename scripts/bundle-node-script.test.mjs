import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundleNodeOnly, nonNodeImports } from './bundle-node-script.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'bundle-node-script-test-')
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('nonNodeImports: lists every import that is not a node: built-in', () => {
  const code = [
    "import fs from 'node:fs';",
    'import http from "node:http";',
    "import { x } from 'commander';",
    "import y from './local.js';",
    '',
  ].join('\n');
  assert.deepEqual(nonNodeImports(code), ['commander', './local.js']);
  assert.deepEqual(nonNodeImports("import fs from 'node:fs';\n"), []);
});

test('bundleNodeOnly: inlines local modules and keeps node: imports external', async t => {
  const dir = tempDir(t);
  fs.writeFileSync(
    path.join(dir, 'util.ts'),
    'export const greet = (n: string): string => `hi ${n}`;\n'
  );
  fs.writeFileSync(
    path.join(dir, 'entry.ts'),
    "import fs from 'node:fs';\nimport { greet } from './util.js';\nconsole.log(greet('x'), typeof fs);\n"
  );
  const code = await bundleNodeOnly(path.join(dir, 'entry.ts'), 'test');
  assert.match(code, /from "node:fs"/);
  assert.match(code, /hi \$\{/);
  assert.deepEqual(nonNodeImports(code), []);
});

test('bundleNodeOnly: a third-party import fails the build loudly', async t => {
  const dir = tempDir(t);
  fs.writeFileSync(
    path.join(dir, 'entry.ts'),
    "import { Command } from 'commander';\nnew Command();\n"
  );
  await assert.rejects(
    bundleNodeOnly(path.join(dir, 'entry.ts'), 'demo'),
    /demo bundle must only import node built-ins, found: commander/
  );
});
