import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readStoreServe,
  removeStoreServe,
  storeServeFile,
  writeStoreServe,
} from './storeServe.js';

test('storeServe: written, read back, and removed only by the process that wrote it', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'e-store-serve-'));
  try {
    assert.equal(readStoreServe(store), undefined);
    writeStoreServe(store, { pid: 10, host: '127.0.0.1', port: 8080 });
    assert.equal(storeServeFile(store), path.join(store, 'runs', 'serve.json'));
    assert.deepEqual(readStoreServe(store), {
      pid: 10,
      host: '127.0.0.1',
      port: 8080,
    });
    // A newer serve took the file over: an older one closing leaves it.
    removeStoreServe(store, 9);
    assert.ok(readStoreServe(store));
    removeStoreServe(store, 10);
    assert.equal(readStoreServe(store), undefined);
    // Garbage reads as absent.
    fs.writeFileSync(storeServeFile(store), '{"pid":');
    assert.equal(readStoreServe(store), undefined);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});
