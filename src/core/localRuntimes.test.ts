import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LLAMACPP_CATALOG,
  LOCAL_RUNTIMES,
  OLLAMA_CATALOG,
  RUNTIME_CATALOGS,
  VLLM_CATALOG,
  composeModelCatalog,
  isLocalRuntime,
  type LocalRuntime,
} from './localRuntimes.js';
import type { ModelCatalogEntry } from './modelStatus.js';

const ids = (entries: readonly ModelCatalogEntry[]): string[] =>
  entries.map(entry => entry.id);

type Catalogs = Readonly<Record<LocalRuntime, readonly ModelCatalogEntry[]>>;

test('isLocalRuntime: exactly the declared runtime ids, and only strings', () => {
  for (const runtime of LOCAL_RUNTIMES) {
    assert.equal(isLocalRuntime(runtime.id), true);
  }
  assert.equal(isLocalRuntime('lmstudio'), false);
  assert.equal(isLocalRuntime('Ollama'), false);
  assert.equal(isLocalRuntime(''), false);
  // `config.json` is user-editable, so the guard also fences off non-strings.
  assert.equal(isLocalRuntime(undefined), false);
  assert.equal(isLocalRuntime(null), false);
  assert.equal(isLocalRuntime(['ollama']), false);
  assert.equal(isLocalRuntime({ id: 'ollama' }), false);
});

test('RUNTIME_CATALOGS: every declared runtime has a catalog and no catalog is empty', () => {
  assert.deepEqual(
    Object.keys(RUNTIME_CATALOGS).sort(),
    LOCAL_RUNTIMES.map(runtime => runtime.id as string).sort()
  );
  for (const runtime of LOCAL_RUNTIMES) {
    assert.ok(
      RUNTIME_CATALOGS[runtime.id].length > 0,
      `${runtime.id} offers no models`
    );
  }
});

test('composeModelCatalog: no runtimes selected offers no models', () => {
  assert.deepEqual(composeModelCatalog([]), []);
});

test('composeModelCatalog: concatenates in the order the caller selected, not catalog order', () => {
  assert.deepEqual(composeModelCatalog(['vllm', 'ollama']), [
    ...VLLM_CATALOG,
    ...OLLAMA_CATALOG,
  ]);
  assert.deepEqual(composeModelCatalog(['ollama', 'vllm']), [
    ...OLLAMA_CATALOG,
    ...VLLM_CATALOG,
  ]);
});

test('composeModelCatalog: the shipped catalogs are disjoint, so selecting all three offers every model once', () => {
  const all = composeModelCatalog(LOCAL_RUNTIMES.map(runtime => runtime.id));
  assert.deepEqual(all, [
    ...LLAMACPP_CATALOG,
    ...OLLAMA_CATALOG,
    ...VLLM_CATALOG,
  ]);
  assert.equal(new Set(ids(all)).size, all.length);
});

test('composeModelCatalog: deduplicates by id, keeping the first runtime that offers it', () => {
  const catalogs: Catalogs = {
    llamacpp: [
      { id: 'shared/model', sizeBytes: 1 },
      { id: 'only/llamacpp', sizeBytes: 2 },
    ],
    ollama: [
      { id: 'shared/model', sizeBytes: 999 },
      { id: 'only/ollama', sizeBytes: 3 },
    ],
    vllm: [{ id: 'shared/model', sizeBytes: 777 }],
  };
  const merged = composeModelCatalog(['llamacpp', 'ollama', 'vllm'], catalogs);
  assert.deepEqual(ids(merged), [
    'shared/model',
    'only/llamacpp',
    'only/ollama',
  ]);
  // First occurrence wins whole, not just its id: the wizard shows its size.
  assert.equal(merged[0].sizeBytes, 1);
});

test('composeModelCatalog: the same runtime selected twice contributes its models once', () => {
  assert.deepEqual(composeModelCatalog(['ollama', 'ollama']), [
    ...OLLAMA_CATALOG,
  ]);
});

test('composeModelCatalog: returns a fresh array, never the shipped catalog itself', () => {
  const merged = composeModelCatalog(['llamacpp']);
  assert.notEqual(merged, LLAMACPP_CATALOG);
  merged.pop();
  assert.equal(
    composeModelCatalog(['llamacpp']).length,
    LLAMACPP_CATALOG.length
  );
});
