import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { RunScratch } from './runScratch.js';

test('file: writes the content and returns an existing path', () => {
  const scratch = new RunScratch();
  try {
    const p = scratch.file('provider.env', 'KEY=value\n');
    assert.equal(path.basename(p), 'provider.env');
    assert.equal(fs.readFileSync(p, 'utf8'), 'KEY=value\n');
  } finally {
    scratch.dispose();
  }
});

// Windows has no POSIX permission bits: stat reports 0o666 whatever was asked.
test(
  'file: defaults to mode 0600 (secrets), honours an explicit mode',
  { skip: process.platform === 'win32' && 'no POSIX file modes' },
  () => {
    const scratch = new RunScratch();
    try {
      const secret = scratch.file('a.env', 'x');
      assert.equal(fs.statSync(secret).mode & 0o777, 0o600);
      const open = scratch.file('b.txt', 'y', { mode: 0o644 });
      assert.equal(fs.statSync(open).mode & 0o777, 0o644);
    } finally {
      scratch.dispose();
    }
  }
);

test('dir: returns a fresh empty directory', () => {
  const scratch = new RunScratch();
  try {
    const d = scratch.dir();
    assert.ok(fs.statSync(d).isDirectory());
    assert.deepEqual(fs.readdirSync(d), []);
  } finally {
    scratch.dispose();
  }
});

test('dispose: removes every file and dir it created', () => {
  const scratch = new RunScratch();
  const a = scratch.file('a.env', '1');
  const b = scratch.dir();
  scratch.dispose();
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(b), false);
});

test('dispose: is idempotent (safe from a finally and again on error)', () => {
  const scratch = new RunScratch();
  scratch.file('a.env', '1');
  scratch.dispose();
  assert.doesNotThrow(() => scratch.dispose());
});
