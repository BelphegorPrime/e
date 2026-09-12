import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SIBLING_ARTIFACTS } from '../store/config.js';
import {
  artifactsDirFor,
  copyArtifact,
  isNeverSynced,
  planArtifactSync,
  removeArtifacts,
  syncArtifacts,
} from './runArtifacts.js';
import { seedParentArtifacts } from './runSpawn.testSupport.js';

test('the default allowlist is node_modules', () => {
  assert.deepEqual([...DEFAULT_SIBLING_ARTIFACTS], ['node_modules']);
  assert.deepEqual(planArtifactSync(DEFAULT_SIBLING_ARTIFACTS), [
    'node_modules',
  ]);
});

test('isNeverSynced: git metadata and env files, nothing else', () => {
  for (const name of ['.git', '.env', '.env.local', '.env.production']) {
    assert.equal(isNeverSynced(name), true, name);
  }
  for (const name of [
    'node_modules',
    '.gitignore',
    'env',
    '.envrc',
    'environment',
  ]) {
    assert.equal(isNeverSynced(name), false, name);
  }
});

test('planArtifactSync: never .env or .git, whatever the config says, at any depth', () => {
  assert.deepEqual(
    planArtifactSync([
      'node_modules',
      '.env',
      '.git',
      '.env.local',
      'a/.git/b',
      'x/.env',
    ]),
    ['node_modules']
  );
});

test('planArtifactSync: drops absolute and escaping paths, normalizes and de-duplicates the rest', () => {
  assert.deepEqual(
    planArtifactSync([
      '/etc',
      '../sibling',
      'a/../b',
      '',
      '  ',
      '.',
      './node_modules/',
      'node_modules',
      'packages\\app\\node_modules',
      'dist//',
    ]),
    ['node_modules', 'packages/app/node_modules', 'dist']
  );
});

test('artifactsDirFor: under the worktrees dir, apart from the worktrees', () => {
  assert.equal(
    artifactsDirFor('/wt', 'e-demo-task-1'),
    path.join('/wt', '.artifacts', 'e-demo-task-1')
  );
});

/** A seeded parent worktree and an absent target dir under one temp root. */
function withDirs<T>(fn: (parent: string, target: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-artifacts-'));
  try {
    const parent = path.join(root, 'parent');
    fs.mkdirSync(parent);
    seedParentArtifacts(parent);
    // Git metadata at the top level too: never an allowed entry.
    fs.mkdirSync(path.join(parent, '.git'));
    fs.writeFileSync(path.join(parent, '.git', 'config'), '[core]\n');
    return fn(parent, path.join(root, 'target'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('syncArtifacts: copies allowed entries into the target and mounts them at the same workspace path', () => {
  withDirs((parent, target) => {
    const result = syncArtifacts({
      parentWorktree: parent,
      targetDir: target,
      entries: ['node_modules', '.env', '.git', 'dist'],
    });
    assert.deepEqual(result.copied, ['node_modules']);
    assert.deepEqual(result.missing, ['dist']);
    assert.deepEqual(result.refused, []);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.mounts, [
      {
        host: path.join(target, 'node_modules'),
        container: '/workspace/node_modules',
      },
    ]);
    assert.equal(
      fs.readFileSync(
        path.join(target, 'node_modules', 'pkg', 'index.js'),
        'utf8'
      ),
      'module.exports = 1;\n'
    );
    // The .bin symlink is kept verbatim (relative), so it resolves in the container.
    const link = path.join(target, 'node_modules', '.bin', 'tool');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(link), '../pkg/index.js');
    // Secrets and git metadata never travel: not as entries, not inside a tree.
    assert.equal(fs.existsSync(path.join(target, '.env')), false);
    assert.equal(fs.existsSync(path.join(target, '.git')), false);
    assert.equal(
      fs.existsSync(path.join(target, 'node_modules', 'pkg', '.env')),
      false
    );
    assert.equal(
      fs.existsSync(path.join(target, 'node_modules', '.git')),
      false
    );
  });
});

test('syncArtifacts: a nested entry mounts at its nested workspace path', () => {
  withDirs((parent, target) => {
    fs.mkdirSync(path.join(parent, 'packages', 'app', 'node_modules', 'x'), {
      recursive: true,
    });
    const result = syncArtifacts({
      parentWorktree: parent,
      targetDir: target,
      entries: ['packages/app/node_modules'],
      workspace: '/work',
    });
    assert.deepEqual(result.mounts, [
      {
        host: path.join(target, 'packages', 'app', 'node_modules'),
        container: '/work/packages/app/node_modules',
      },
    ]);
    assert.ok(
      fs
        .statSync(path.join(target, 'packages', 'app', 'node_modules', 'x'))
        .isDirectory()
    );
  });
});

test('syncArtifacts: refuses a symlinked entry and a symlink on the way to one (no host escape through the mount)', () => {
  withDirs((parent, target) => {
    // The agent controls its worktree: `dist -> /` would mount the host root.
    fs.symlinkSync(os.tmpdir(), path.join(parent, 'dist'));
    // A symlinked intermediate segment, even one pointing inside the worktree.
    fs.symlinkSync('node_modules', path.join(parent, 'alias'));
    const result = syncArtifacts({
      parentWorktree: parent,
      targetDir: target,
      entries: ['dist', 'alias/pkg', 'node_modules'],
    });
    assert.deepEqual(result.refused, ['dist', 'alias/pkg']);
    assert.deepEqual(result.copied, ['node_modules']);
    assert.equal(fs.existsSync(path.join(target, 'dist')), false);
    assert.equal(fs.existsSync(path.join(target, 'alias')), false);
  });
});

test('syncArtifacts: a missing parent worktree syncs nothing and throws nothing', () => {
  withDirs((parent, target) => {
    const result = syncArtifacts({
      parentWorktree: path.join(parent, 'nope'),
      targetDir: target,
      entries: ['node_modules'],
    });
    assert.deepEqual(result, {
      copied: [],
      missing: ['node_modules'],
      refused: [],
      failed: [],
      mounts: [],
    });
    assert.equal(fs.existsSync(target), false);
  });
});

test('syncArtifacts: a failed copy is reported, leaves no half tree, and mounts nothing', () => {
  withDirs((parent, target) => {
    // The target "dir" is a file: creating the copy's parent must fail.
    fs.writeFileSync(target, 'in the way');
    const result = syncArtifacts({
      parentWorktree: parent,
      targetDir: target,
      entries: ['node_modules'],
    });
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].entry, 'node_modules');
    assert.match(result.failed[0].error, /ENOTDIR|EEXIST|ENOENT/);
    assert.deepEqual(result.mounts, []);
    assert.deepEqual(result.copied, []);
  });
});

test('copyArtifact: creates the destination parent as needed', () => {
  withDirs((parent, target) => {
    copyArtifact(
      path.join(parent, 'node_modules', 'pkg'),
      path.join(target, 'deep', 'pkg')
    );
    assert.ok(fs.existsSync(path.join(target, 'deep', 'pkg', 'index.js')));
  });
});

test('removeArtifacts: removes the tree and tolerates a dir that never existed', () => {
  withDirs((parent, target) => {
    syncArtifacts({
      parentWorktree: parent,
      targetDir: target,
      entries: ['node_modules'],
    });
    removeArtifacts(target);
    assert.equal(fs.existsSync(target), false);
    removeArtifacts(target);
  });
});
