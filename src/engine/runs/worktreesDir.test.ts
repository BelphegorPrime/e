import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveWorktreesDir, worktreePathFor } from './worktreesDir.js';

const base = {
  homedir: '/home/dev',
  tmpdir: '/tmp',
  environment: {} as Record<string, string | undefined>,
};

test('resolveWorktreesDir: Linux (and anything unknown) uses the temp dir', () => {
  assert.equal(
    resolveWorktreesDir({ ...base, platform: 'linux' }),
    path.join('/tmp', 'e-worktrees')
  );
  assert.equal(
    resolveWorktreesDir({ ...base, platform: 'freebsd' }),
    path.join('/tmp', 'e-worktrees')
  );
});

test('resolveWorktreesDir: macOS uses a cache dir under home, which every VM engine shares', () => {
  assert.equal(
    resolveWorktreesDir({ ...base, platform: 'darwin', homedir: '/Users/dev' }),
    path.join('/Users/dev', 'Library', 'Caches', 'e', 'worktrees')
  );
});

test('resolveWorktreesDir: Windows uses LOCALAPPDATA, falling back to the profile', () => {
  assert.equal(
    resolveWorktreesDir({
      ...base,
      platform: 'win32',
      homedir: 'C:\\Users\\dev',
      environment: { LOCALAPPDATA: 'D:\\Local' },
    }),
    path.join('D:\\Local', 'e', 'worktrees')
  );
  assert.equal(
    resolveWorktreesDir({
      ...base,
      platform: 'win32',
      homedir: 'C:\\Users\\dev',
    }),
    path.join('C:\\Users\\dev', 'AppData', 'Local', 'e', 'worktrees')
  );
});

test('resolveWorktreesDir: E_WORKTREES_DIR overrides every platform default', () => {
  const environment = { E_WORKTREES_DIR: '/mnt/shared/wt' };
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.equal(
      resolveWorktreesDir({ ...base, platform, environment }),
      path.resolve('/mnt/shared/wt')
    );
  }
  // Blank means unset.
  assert.equal(
    resolveWorktreesDir({
      ...base,
      platform: 'linux',
      environment: { E_WORKTREES_DIR: '  ' },
    }),
    path.join('/tmp', 'e-worktrees')
  );
});

test('worktreePathFor: nests the branch segments under the worktrees dir', () => {
  assert.equal(
    worktreePathFor('/tmp/e-worktrees', 'e/demo/fix-login-1'),
    path.join('/tmp/e-worktrees', 'e', 'demo', 'fix-login-1')
  );
});
