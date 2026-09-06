import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { resolveUiDirectory } from './assets';

function tempUiDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-assets-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('resolveUiDirectory: resolves dist/ui next to the entry when present', t => {
  const entryDir = tempUiDir(t);
  fs.mkdirSync(path.join(entryDir, 'ui', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(entryDir, 'ui', 'index.html'), '<html></html>');
  assert.equal(resolveUiDirectory(entryDir), path.join(entryDir, 'ui'));
});

test('resolveUiDirectory: throws with a build hint when ui/index.html is missing', t => {
  const entryDir = tempUiDir(t);
  assert.throws(
    () => resolveUiDirectory(entryDir),
    /UI assets are missing at .*npm run build:ui/
  );
});

test('resolveUiDirectory: throws when the ui directory does not exist at all', t => {
  const entryDir = tempUiDir(t);
  assert.throws(() => resolveUiDirectory(entryDir), /UI assets are missing/);
});
