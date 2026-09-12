import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveRoot,
  resolveConfig,
  resolveModels,
  serializeConfig,
  readConfig,
  writeConfig,
  readModelsJson,
  writeModelsJson,
  isInitialized,
  isEgressInitialized,
  configFilePath,
  modelsFilePath,
  DEFAULT_HARNESS,
} from './index.js';
import { MODELS } from '../modelStatus.js';

// resolveRoot is pure: it takes cwd, homedir, and a `hasStore` predicate, so we
// exercise the resolution order with synthetic paths and a fake predicate - no
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
  // Windows resolves a bare `/some/project` onto the current drive.
  assert.equal(root, path.resolve('/some/project'));
  assert.equal(consulted, false, 'explicitDir short-circuits the walk');
});

test('resolveRoot: walk-up finds the nearest ancestor with a store', () => {
  const withStore = '/home/user/proj';
  const root = resolveRoot({
    explicitDir: undefined,
    cwd: '/home/user/proj/packages/cli',
    homedir: '/home/user',
    hasStore: dir => dir === withStore,
  });
  assert.equal(root, withStore);
});

test('resolveRoot: falls back to home when no ancestor has a store', () => {
  const root = resolveRoot({
    explicitDir: undefined,
    cwd: '/home/user/proj/packages/cli',
    homedir: '/home/user',
    hasStore: dir => dir === '/home/user',
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
    hasStore: dir => dir === '/a/b/c',
  });
  assert.equal(root, '/a/b/c');
});

// resolveConfig is pure: the glue hands it already-parsed JSON (or undefined for
// a missing file), and it fills defaults for anything absent or malformed.

test('resolveConfig: a missing config yields the built-in defaults', () => {
  assert.deepEqual(resolveConfig(undefined), {
    defaultHarness: DEFAULT_HARNESS,
    models: MODELS,
    localRuntimes: ['llamacpp'],
    siblingArtifacts: ['node_modules'],
    maxSiblings: 3,
    gitPlatform: undefined,
  });
});

test('resolveConfig: an explicit defaultHarness is kept', () => {
  assert.deepEqual(resolveConfig({ defaultHarness: 'codex' }), {
    defaultHarness: 'codex',
    models: MODELS,
    localRuntimes: ['llamacpp'],
    siblingArtifacts: ['node_modules'],
    maxSiblings: 3,
    gitPlatform: undefined,
  });
});

test('resolveConfig: an explicit gitPlatform is kept; malformed ones are dropped', () => {
  assert.equal(resolveConfig({ gitPlatform: 'gitlab' }).gitPlatform, 'gitlab');
  assert.equal(
    resolveConfig({ gitPlatform: 'bitbucket' } as unknown as Record<
      string,
      unknown
    >).gitPlatform,
    undefined
  );
  assert.equal(
    resolveConfig({ gitPlatform: 42 } as unknown as Record<string, unknown>)
      .gitPlatform,
    undefined
  );
});

test('resolveConfig: a blank or non-string defaultHarness falls back to the default', () => {
  assert.equal(
    resolveConfig({ defaultHarness: '' }).defaultHarness,
    DEFAULT_HARNESS
  );
  assert.equal(
    resolveConfig({ defaultHarness: 42 as unknown as string }).defaultHarness,
    DEFAULT_HARNESS
  );
  assert.equal(resolveConfig({}).defaultHarness, DEFAULT_HARNESS);
});

test('resolveConfig: an explicit models selection is kept', () => {
  assert.deepEqual(resolveConfig({ models: ['org/one'] }).models, ['org/one']);
});

test('resolveConfig: an empty or malformed models list falls back to the default catalog', () => {
  assert.deepEqual(resolveConfig({ models: [] }).models, MODELS);
  assert.deepEqual(resolveConfig({ models: [1, 2] }).models, MODELS);
  assert.deepEqual(resolveConfig({}).models, MODELS);
});

test('serializeConfig: pretty JSON with a trailing newline', () => {
  assert.equal(
    serializeConfig({ defaultHarness: 'pi' }),
    '{\n  "defaultHarness": "pi"\n}\n'
  );
});

test('config round-trip: writeConfig then readConfig returns the written value', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-store-'));
  try {
    writeConfig(
      {
        defaultHarness: 'codex',
        models: ['org/one'],
        localRuntimes: ['llamacpp'],
        gitPlatform: 'gitlab',
        siblingArtifacts: ['node_modules', 'dist'],
        maxSiblings: 2,
      },
      root
    );
    assert.equal(fs.existsSync(configFilePath(root)), true);
    assert.deepEqual(readConfig(root), {
      defaultHarness: 'codex',
      models: ['org/one'],
      localRuntimes: ['llamacpp'],
      gitPlatform: 'gitlab',
      siblingArtifacts: ['node_modules', 'dist'],
      maxSiblings: 2,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readConfig: a missing config.json returns the defaults, no file written', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-store-'));
  try {
    assert.deepEqual(readConfig(root), {
      defaultHarness: DEFAULT_HARNESS,
      models: MODELS,
      localRuntimes: ['llamacpp'],
      siblingArtifacts: ['node_modules'],
      maxSiblings: 3,
      gitPlatform: undefined,
    });
    assert.ok(!fs.existsSync(configFilePath(root)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveConfig: an unknown localRunTimes entry is dropped, valid ones kept', () => {
  const config = resolveConfig({
    localRuntimes: ['llamacpp', 'bogus', 42],
  });
  assert.deepEqual(config.localRuntimes, ['llamacpp']);
});

test('resolveConfig: missing localRuntimes falls back to llamacpp (legacy store)', () => {
  assert.deepEqual(resolveConfig({}).localRuntimes, ['llamacpp']);
});

test('resolveModels: drops nulls, keeps well-formed entries, defaults to empty', () => {
  const kept = {
    id: 'org/model',
    object: 'model',
    created: 1,
    owned_by: 'org',
  };
  assert.deepEqual(resolveModels([kept, null]), [kept]);
  assert.deepEqual(resolveModels(undefined as unknown as unknown[]), []);
  assert.deepEqual(resolveModels({} as unknown as unknown[]), []);
});

test('readModelsJson: a missing file yields the defaults (empty list), no file written', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-store-'));
  try {
    assert.deepEqual(readModelsJson(root), []);
    assert.ok(!fs.existsSync(modelsFilePath(root)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('models round-trip: writeModelsJson then readModelsJson returns the written value', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-store-'));
  const entries = [
    { id: 'org/model', object: 'model', created: 42, owned_by: 'org' },
  ];
  try {
    writeModelsJson(entries, root);
    assert.deepEqual(readModelsJson(root), entries);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isInitialized: true only after the harness Dockerfile exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-store-'));
  try {
    assert.equal(isInitialized('claude', root), false);
    fs.mkdirSync(path.join(root, '.e', 'harnesses', 'claude'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, '.e', 'harnesses', 'claude', 'Dockerfile'),
      'FROM node'
    );
    assert.equal(isInitialized('claude', root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isEgressInitialized: true only after the egress Dockerfile exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-store-'));
  try {
    assert.equal(isEgressInitialized(root), false);
    fs.mkdirSync(path.join(root, '.e', 'egress'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.e', 'egress', 'Dockerfile'),
      'FROM node'
    );
    assert.equal(isEgressInitialized(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveConfig: siblingArtifacts is kept as configured (an empty list disables the sync), malformed falls back', () => {
  assert.deepEqual(
    resolveConfig({
      siblingArtifacts: ['node_modules', 'packages/app/node_modules'],
    }).siblingArtifacts,
    ['node_modules', 'packages/app/node_modules']
  );
  assert.deepEqual(
    resolveConfig({ siblingArtifacts: [] }).siblingArtifacts,
    []
  );
  assert.deepEqual(
    resolveConfig({ siblingArtifacts: 'node_modules' }).siblingArtifacts,
    ['node_modules']
  );
  assert.deepEqual(
    resolveConfig({ siblingArtifacts: ['ok', 42] }).siblingArtifacts,
    ['node_modules']
  );
});

test('resolveConfig: maxSiblings is a positive integer, default 3, malformed falls back', () => {
  assert.equal(resolveConfig(undefined).maxSiblings, 3);
  assert.equal(resolveConfig({ maxSiblings: 5 }).maxSiblings, 5);
  assert.equal(resolveConfig({ maxSiblings: 1 }).maxSiblings, 1);
  for (const bad of [0, -1, 2.5, '3', null]) {
    assert.equal(
      resolveConfig({ maxSiblings: bad }).maxSiblings,
      3,
      String(bad)
    );
  }
});
