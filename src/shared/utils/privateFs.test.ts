import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  privateDir,
  privateIgnoredDir,
  writePrivateFileAtomic,
} from './privateFs.js';

function withTmp(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-private-fs-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('privateDir: 0700 whatever the umask, and tightens one that exists', () => {
  withTmp(tmp => {
    const dir = path.join(tmp, 'a', 'b');
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    privateDir(dir);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  });
});

test('writePrivateFileAtomic: 0600, whole, no temp file left, bytes kept as bytes', () => {
  withTmp(tmp => {
    const file = path.join(tmp, 'x.bin');
    writePrivateFileAtomic(file, Buffer.from([0xe9, 0x00, 0xff]));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual([...fs.readFileSync(file)], [0xe9, 0x00, 0xff]);
    assert.deepEqual(fs.readdirSync(tmp), ['x.bin']);
  });
});

test('privateIgnoredDir: a private directory git ignores, the ignore file private too', () => {
  withTmp(tmp => {
    const dir = path.join(tmp, 'runs', 'x');
    privateIgnoredDir(dir);
    const ignore = path.join(dir, '.gitignore');
    assert.equal(fs.readFileSync(ignore, 'utf8'), '*\n');
    assert.equal(fs.statSync(ignore).mode & 0o777, 0o600);
    // An existing one is left as the user made it.
    fs.writeFileSync(ignore, '*\n!keep\n');
    privateIgnoredDir(dir);
    assert.equal(fs.readFileSync(ignore, 'utf8'), '*\n!keep\n');
  });
});
