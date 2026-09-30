import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eBaseDir, triggerConfigPath } from '../../core/store/paths.js';
import {
  recordedRunRepositories,
  recordRunRepository,
  runNamespace,
} from './runNamespace.js';

/*
 * The run namespace (#208): every repository whose runs share one Store's
 * run names, from its triggers' `repo` and from the record its runs leave.
 */

function withStore(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-run-ns-'));
  try {
    fs.mkdirSync(eBaseDir(root), { recursive: true });
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeTrigger(root: string, name: string, repo: string): void {
  const file = triggerConfigPath(name, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      agent: 'pi',
      prompt: 'p',
      repo,
      on: { type: 'cron', expr: '0 3 * * *' },
    })
  );
}

/** Runs `fn` with `root` as the home directory, which makes its Store the home Store. */
function asHome(root: string, fn: () => void): void {
  const home = process.env.HOME;
  process.env.HOME = root;
  try {
    fn();
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
}

test('a recorded repository is listed once, however often a run records it', () => {
  withStore(root => {
    const storeDir = eBaseDir(root);
    assert.deepEqual(recordedRunRepositories(storeDir), []);
    recordRunRepository(storeDir, '/src/a');
    recordRunRepository(storeDir, '/src/a/');
    recordRunRepository(storeDir, '/src/b');
    assert.deepEqual(recordedRunRepositories(storeDir).sort(), [
      path.resolve('/src/a'),
      path.resolve('/src/b'),
    ]);
  });
});

test('a corrupt record reads as absent', () => {
  withStore(root => {
    const storeDir = eBaseDir(root);
    recordRunRepository(storeDir, '/src/a');
    const dir = path.join(storeDir, 'runs', 'repos');
    fs.writeFileSync(path.join(dir, 'broken.json'), '{');
    assert.deepEqual(recordedRunRepositories(storeDir), [
      path.resolve('/src/a'),
    ]);
  });
});

test("a home Store's namespace is its trigger repos and every recorded one, once each", () => {
  withStore(root => {
    writeTrigger(root, 'nightly', '/src/a');
    recordRunRepository(eBaseDir(root), '/src/a');
    recordRunRepository(eBaseDir(root), '/src/serve');
    asHome(root, () => {
      assert.deepEqual(runNamespace(root).sort(), [
        path.resolve('/src/a'),
        path.resolve('/src/serve'),
      ]);
    });
  });
});

test('a repo-local Store counts only what its runs recorded; no Store has none', () => {
  withStore(root => {
    writeTrigger(root, 'nightly', '/src/a');
    assert.deepEqual(runNamespace(root), []);
    recordRunRepository(eBaseDir(root), root);
    assert.deepEqual(runNamespace(root), [path.resolve(root)]);
  });
  assert.deepEqual(runNamespace(undefined), []);
});
