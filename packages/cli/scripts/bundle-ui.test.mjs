import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MANIFEST_NAME,
  copyUiAssets,
  isUiFresh,
  isUiSourceStale,
  readManifest,
  sha256,
  verifyWebpackOutput,
} from './bundle-ui.mjs';

/** Builds a fake webpack output: index.html plus one hashed asset. */
function fakeUiBuild(dir, { assetContent = 'console.log("ui")' } = {}) {
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>\n');
  fs.writeFileSync(path.join(dir, 'assets', 'main.js'), assetContent);
  return dir;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-ui-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('sha256: stable, content-derived hex digest', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'hello');
  assert.equal(sha256(file), sha256(file));
  fs.writeFileSync(file, 'hello2');
  assert.equal(
    sha256(file),
    '87298cc2f31fba73181ea2a9e6ef10dce21ed95e98bdac9c4e1504ea16f486e4'
  );
});

test('verifyWebpackOutput: accepts a complete build and lists files with hashes', t => {
  const dir = tempDir(t);
  fakeUiBuild(dir);
  const manifest = verifyWebpackOutput(dir);
  assert.deepEqual(
    manifest.files.map(file => file.path),
    ['index.html', path.join('assets', 'main.js')]
  );
  assert.ok(manifest.files.every(file => /^[0-9a-f]{64}$/.test(file.sha256)));
});

test('verifyWebpackOutput: throws with a hint when index.html is missing', t => {
  const dir = tempDir(t);
  assert.throws(
    () => verifyWebpackOutput(dir),
    /index.html .*npm run build --workspace @e\/ui/
  );
});

test('verifyWebpackOutput: throws on empty assets output', t => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>\n');
  assert.throws(() => verifyWebpackOutput(dir), /no bundled assets/);
});

test('copyUiAssets: copies, verifies hashes, and writes the manifest', t => {
  const source = fakeUiBuild(tempDir(t));
  const dest = tempDir(t);
  const fileCount = copyUiAssets(source, dest);
  assert.equal(fileCount, 2);
  assert.equal(fs.readFileSync(path.join(dest, 'index.html'), 'utf8'), '<html></html>\n');
  const manifest = readManifest(dest);
  assert.ok(manifest);
  assert.equal(manifest.files.length, 2);
  const sourceManifest = verifyWebpackOutput(source);
  assert.deepEqual(manifest.files, sourceManifest.files);
});

test('copyUiAssets: wipes a previous bundle and never contaminates it', t => {
  const source = fakeUiBuild(tempDir(t));
  const dest = tempDir(t);
  fs.writeFileSync(path.join(dest, 'stale.js'), 'old\n');
  copyUiAssets(source, dest);
  assert.equal(fs.existsSync(path.join(dest, 'stale.js')), false);
});

test('copyUiAssets: refuses to copy onto itself or wipe root/home', t => {
  const source = fakeUiBuild(tempDir(t));
  assert.throws(() => copyUiAssets(source, source), /onto itself/);
  assert.throws(() => copyUiAssets(source, '/'), /filesystem root/);
  assert.throws(() => copyUiAssets(source, os.homedir()), /home directory/);
});

test('isUiFresh: true only while dest matches the source build', t => {
  const source = fakeUiBuild(tempDir(t));
  const dest = tempDir(t);
  copyUiAssets(source, dest);
  assert.equal(isUiFresh(source, dest), true);
  // Touch the source asset: the shipped copy is now stale.
  fs.writeFileSync(
    path.join(source, 'assets', 'main.js'),
    'console.log("changed")'
  );
  assert.equal(isUiFresh(source, dest), false);
});

test('isUiFresh: false when no manifest exists in dest', t => {
  const source = fakeUiBuild(tempDir(t));
  const bare = tempDir(t);
  fs.mkdirSync(path.join(bare, 'assets'), { recursive: true });
  fs.cpSync(source, bare, { recursive: true });
  fs.rmSync(path.join(bare, MANIFEST_NAME), { force: true });
  assert.equal(isUiFresh(source, bare), false);
});

test('isUiSourceStale: false on a fresh build, true after source edits', t => {
  const root = tempDir(t);
  const srcDir = path.join(root, 'src');
  const buildDir = path.join(root, 'dist', 'ui');
  fs.mkdirSync(path.join(srcDir, 'pages'), { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'pages', 'runs.tsx'), 'export {};\n');
  fs.writeFileSync(path.join(buildDir, 'index.html'), '<html></html>\n');
  assert.equal(isUiSourceStale(root, buildDir), false);
  // Editing source after the build (or deleting the build) marks it stale.
  fs.writeFileSync(path.join(srcDir, 'pages', 'runs.tsx'), 'export const x = 1;\n');
  assert.equal(isUiSourceStale(root, buildDir), true);
  fs.rmSync(buildDir, { recursive: true, force: true });
  assert.equal(isUiSourceStale(root, buildDir), true);
});