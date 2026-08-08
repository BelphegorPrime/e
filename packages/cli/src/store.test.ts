import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveRoot,
  resolveConfig,
  serializeConfig,
  readConfig,
  writeConfig,
  configFilePath,
  DEFAULT_HARNESS,
} from './store';

// resolveRoot is pure: it takes cwd, homedir, and a `hasStore` predicate, so we
// exercise the resolution order with synthetic paths and a fake predicate — no
// temp dirs and no process.chdir.

test('resolveRoot: explicitDir wins, resolved to absolute, without consulting hasStore', () => {
  let consulted = false;
  const root = resolveRoot({
    explicitDir: '/some/project',
    cwd: '/anywhere',
    homedir: '/home/user',
    hasStore: () => {
      consulted = true;
      return true;
    },
  });
  assert.equal(root, '/some/project');
  assert.equal(consulted, false, 'explicitDir short-circuits the walk');
});

test('resolveRoot: walk-up finds the nearest ancestor with a store', () => {
  const withStore = '/home/user/proj';
  const root = resolveRoot({
    explicitDir: undefined,
    cwd: '/home/user/proj/packages/cli',
    homedir: '/home/user',
    hasStore: (dir) => dir === withStore,
  });
  assert.equal(root, withStore);
});

test('resolveRoot: falls back to home when no ancestor has a store', () => {
  const root = resolveRoot({
    explicitDir: undefined,
    cwd: '/home/user/proj/packages/cli',
    homedir: '/home/user',
    hasStore: (dir) => dir === '/home/user',
  });
  assert.equal(root, '/home/user');
});

test('resolveRoot: returns undefined when nothing has a store', () => {
  const root = resolveRoot({
    explicitDir: undefined,
    cwd: '/home/user/proj/packages/cli',
    homedir: '/home/user',
    hasStore: () => false,
  });
  assert.equal(root, undefined);
});

test('resolveRoot: cwd itself is checked before its ancestors', () => {
  const root = resolveRoot({
    explicitDir: undefined,
    cwd: '/a/b/c',
    homedir: '/home/user',
    hasStore: (dir) => dir === '/a/b/c',
  });
  assert.equal(root, '/a/b/c');
});

// resolveConfig is pure: the glue hands it already-parsed JSON (or undefined for
// a missing file), and it fills defaults for anything absent or malformed.

test('resolveConfig: a missing config yields the built-in defaults', () => {
  assert.deepEqual(resolveConfig(undefined), { defaultHarness: DEFAULT_HARNESS });
});

test('resolveConfig: an explicit defaultHarness is kept', () => {
  assert.deepEqual(resolveConfig({ defaultHarness: 'codex' }), {
    defaultHarness: 'codex',
  });
});

test('resolveConfig: a blank or non-string defaultHarness falls back to the default', () => {
  assert.equal(resolveConfig({ defaultHarness: '' }).defaultHarness, DEFAULT_HARNESS);
  assert.equal(
    resolveConfig({ defaultHarness: 42 as unknown as string }).defaultHarness,
    DEFAULT_HARNESS,
  );
  assert.equal(resolveConfig({}).defaultHarness, DEFAULT_HARNESS);
});

test('serializeConfig: pretty JSON with a trailing newline', () => {
  assert.equal(
    serializeConfig({ defaultHarness: 'pi' }),
    '{\n  "defaultHarness": "pi"\n}\n',
  );
});

test('config round-trip: writeConfig then readConfig returns the written value', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-store-'));
  try {
    writeConfig({ defaultHarness: 'codex' }, root);
    assert.equal(fs.existsSync(configFilePath(root)), true);
    assert.deepEqual(readConfig(root), { defaultHarness: 'codex' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readConfig: a missing config.json returns the defaults, no file written', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-store-'));
  try {
    assert.deepEqual(readConfig(root), { defaultHarness: DEFAULT_HARNESS });
    assert.equal(fs.existsSync(configFilePath(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
