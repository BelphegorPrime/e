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
  readConfigChain,
  writeConfig,
  readModelsJson,
  writeModelsJson,
  isInitialized,
  isEgressInitialized,
  configFilePath,
  verifyCacheVolume,
  DEFAULT_LOOP_CAPS,
  DEFAULT_RESOURCE_CAPS,
  DEFAULT_VERIFY_TIMEOUT_MS,
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
    resources: DEFAULT_RESOURCE_CAPS,
    loop: DEFAULT_LOOP_CAPS,
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
    resources: DEFAULT_RESOURCE_CAPS,
    loop: DEFAULT_LOOP_CAPS,
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
        resources: DEFAULT_RESOURCE_CAPS,
        loop: DEFAULT_LOOP_CAPS,
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
      resources: DEFAULT_RESOURCE_CAPS,
      loop: DEFAULT_LOOP_CAPS,
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
      resources: DEFAULT_RESOURCE_CAPS,
      loop: DEFAULT_LOOP_CAPS,
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

test('resolveConfig: the verify shorthand is a command with no other fields; absent means no gate', () => {
  assert.equal(resolveConfig(undefined).verify, undefined);
  assert.deepEqual(resolveConfig({ verify: 'npm test' }).verify, {
    command: 'npm test',
    // The caps own the default, so it is filled here rather than in runVerify.
    timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
  });
});

test('resolveConfig: the verify object keeps every field it declares', () => {
  assert.deepEqual(
    resolveConfig({
      verify: {
        command: 'npm ci && npm test',
        image: 'golang:1.23',
        timeoutMs: 600000,
        network: true,
        cache: true,
      },
    }).verify,
    {
      command: 'npm ci && npm test',
      image: 'golang:1.23',
      timeoutMs: 600000,
      network: true,
      cache: true,
    }
  );
});

test('resolveConfig: a verify block without a usable command is no gate at all', () => {
  for (const bad of [42, null, [], {}, '', { command: '' }, { command: 42 }]) {
    assert.equal(
      resolveConfig({ verify: bad }).verify,
      undefined,
      JSON.stringify(bad)
    );
  }
});

test('resolveConfig: a malformed verify field is dropped, the command survives', () => {
  assert.deepEqual(
    resolveConfig({
      verify: {
        command: 'npm test',
        image: 42,
        timeoutMs: '600000',
        network: 'yes',
        cache: 1,
      },
    }).verify,
    { command: 'npm test', timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS }
  );
});

test('verifyCacheVolume: one stable, engine-legal name per Store', () => {
  const a = verifyCacheVolume('/home/user/projects/e');
  assert.equal(a, verifyCacheVolume('/home/user/projects/e'), 'stable');
  assert.notEqual(
    a,
    verifyCacheVolume('/home/user/work/e'),
    'two checkouts named `e` do not share a cache'
  );
  assert.match(a, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, 'a legal volume name');
});

test('resolveConfig: the cap blocks default to the documented set, memory and cpus unset', () => {
  const config = resolveConfig(undefined);
  assert.deepEqual(config.loop, {
    maxIterations: 3,
    iterationTimeoutMs: 1_800_000,
    totalTimeoutMs: 10_800_000,
    softTotalTimeoutMs: 7_200_000,
  });
  // Any concrete memory or cpu number is a guess about someone else's
  // hardware, and `resources` applies to every run - so unset is the default
  // and a passing build never starts dying on 137. `pidsLimit` is the
  // exception: a fork bomb takes the box, not just the run.
  assert.deepEqual(config.resources, { pidsLimit: 2048 });
});

test('resolveConfig: a cap block that is absent or not an object falls back whole', () => {
  for (const bad of [undefined, null, 42, 'lots', []]) {
    assert.deepEqual(
      resolveConfig({ loop: bad }).loop,
      DEFAULT_LOOP_CAPS,
      String(bad)
    );
    assert.deepEqual(
      resolveConfig({ resources: bad }).resources,
      DEFAULT_RESOURCE_CAPS,
      String(bad)
    );
  }
});

test('resolveConfig: one malformed cap never costs the rest of its block', () => {
  assert.deepEqual(
    resolveConfig({ loop: { maxIterations: 8, iterationTimeoutMs: 'soon' } })
      .loop,
    { ...DEFAULT_LOOP_CAPS, maxIterations: 8 }
  );
  assert.deepEqual(
    resolveConfig({ resources: { memory: '4g', cpus: -1, pidsLimit: 0 } })
      .resources,
    { memory: '4g', pidsLimit: 2048 }
  );
});

test('resolveConfig: a soft mark that could never warn is dropped, not kept', () => {
  // At or past the hard timeout it never fires, and a setting that silently
  // does nothing is worse than an absent one.
  assert.equal(
    resolveConfig({
      loop: { totalTimeoutMs: 1000, softTotalTimeoutMs: 1000 },
    }).loop.softTotalTimeoutMs,
    undefined
  );
  assert.equal(
    resolveConfig({
      loop: { totalTimeoutMs: 1000, softTotalTimeoutMs: 2000 },
    }).loop.softTotalTimeoutMs,
    undefined
  );
  assert.equal(
    resolveConfig({
      loop: { totalTimeoutMs: 1000, softTotalTimeoutMs: 900 },
    }).loop.softTotalTimeoutMs,
    900
  );
});

test('resolveConfig: a declared verify timeout wins over the caps default', () => {
  assert.equal(
    resolveConfig({ verify: { command: 'npm test', timeoutMs: 60_000 } }).verify
      ?.timeoutMs,
    60_000
  );
  assert.equal(
    resolveConfig({ verify: { command: 'npm test' } }).verify?.timeoutMs,
    DEFAULT_VERIFY_TIMEOUT_MS
  );
});

test('readConfigChain: the gate and the caps come from the repository being worked on', () => {
  const serving = fs.mkdtempSync(path.join(os.tmpdir(), 'e-serving-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'e-target-'));
  try {
    writeConfig(
      {
        ...resolveConfig({ defaultHarness: 'codex', verify: 'serving test' }),
      },
      serving
    );
    writeConfig(
      {
        ...resolveConfig({ verify: 'target test', loop: { maxIterations: 9 } }),
      },
      target
    );

    // The check belongs to the repository, not to whoever triggered the run.
    const chained = readConfigChain({ serving, target });
    assert.equal(chained.verify?.command, 'target test');
    assert.equal(chained.loop.maxIterations, 9);
    // Everything else is the serving Store's: it is the machine's setting.
    assert.equal(chained.defaultHarness, 'codex');

    // A target with no Store of its own inherits the serving one's.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'e-bare-'));
    try {
      assert.equal(
        readConfigChain({ serving, target: bare }).verify?.command,
        'serving test'
      );
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }

    // No target at all is the ordinary case: one Store, read as always.
    assert.equal(readConfigChain({ serving }).verify?.command, 'serving test');
  } finally {
    fs.rmSync(serving, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('readConfigChain: a repository that keeps a config and declares no gate has no gate', () => {
  const serving = fs.mkdtempSync(path.join(os.tmpdir(), 'e-serving-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'e-target-'));
  try {
    writeConfig(resolveConfig({ verify: 'serving test' }), serving);
    writeConfig(resolveConfig({ defaultHarness: 'pi' }), target);
    // Inheriting a check from whoever happened to serve the run would be a
    // stranger's gate on your code.
    assert.equal(readConfigChain({ serving, target }).verify, undefined);
  } finally {
    fs.rmSync(serving, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});
