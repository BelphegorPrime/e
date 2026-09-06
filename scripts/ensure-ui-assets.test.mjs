import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureUiAssets } from './ensure-ui-assets.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-ui-assets-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('ensureUiAssets: passes when the UI bundle is present', t => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>\n');
  assert.equal(ensureUiAssets(dir), dir);
});

test('ensureUiAssets: throws with a build hint when index.html is missing', t => {
  const dir = tempDir(t);
  assert.throws(
    () => ensureUiAssets(dir),
    /UI assets are missing at .*npm run build:ui/
  );
});

test('ensureUiAssets: throws for a partial build without index.html', t => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'main.js'), 'console.log(1)');
  assert.throws(() => ensureUiAssets(dir), /UI assets are missing/);
});
