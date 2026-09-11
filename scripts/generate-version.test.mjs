import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVersion, versionModule } from './generate-version.mjs';

test('resolveVersion: an explicit E_VERSION wins over tag and hash', () => {
  assert.equal(
    resolveVersion({ explicit: '1.2.3', tag: 'v9.9.9', hash: 'abc' }),
    '1.2.3'
  );
});

test('resolveVersion: an exact tag beats the hash and loses its v prefix', () => {
  assert.equal(resolveVersion({ tag: 'v1.2.3', hash: 'abc' }), '1.2.3');
  assert.equal(
    resolveVersion({ tag: '2.0.0-rc.1', hash: 'abc' }),
    '2.0.0-rc.1'
  );
});

test('resolveVersion: falls back to the hash, then to the placeholder', () => {
  assert.equal(resolveVersion({ hash: 'deadbeef' }), 'deadbeef');
  assert.equal(resolveVersion({}), '1.0.0');
});

test('resolveVersion: refuses strings that could escape the generated module', () => {
  assert.throws(() => resolveVersion({ explicit: "1.0'; process.exit(" }));
});

test('versionModule: renders the TypeScript constant', () => {
  assert.equal(versionModule('1.2.3'), "export const E_VERSION = '1.2.3';\n");
});
