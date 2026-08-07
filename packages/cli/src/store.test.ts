import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoot } from './store';

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
