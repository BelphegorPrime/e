import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { diffLines, writeIfAbsent } from './scaffold.js';

test('diffLines: identical content is all unchanged lines', () => {
  const out = diffLines('a\nb\n', 'a\nb\n');
  assert.deepEqual(out, ['  a', '  b', '  ']);
});

test('diffLines: an inserted line shows as + between the unchanged ones', () => {
  const out = diffLines('a\nb\n', 'a\nnew\nb\n');
  assert.deepEqual(out, ['  a', '+ new', '  b', '  ']);
});

test('diffLines: a removed line shows as - and a modified line as -/+', () => {
  const out = diffLines('a\nb\n', 'a\nc\n');
  assert.deepEqual(out, ['  a', '- b', '+ c', '  ']);
});

test('diffLines: trailing-only additions append + lines', () => {
  const out = diffLines('a\n', 'a\nb\nc\n');
  assert.deepEqual(out, ['  a', '+ b', '+ c', '  ']);
});

test('diffLines: a fully different document is all - then + (LCS case)', () => {
  const out = diffLines('one\ntwo\n', 'x\ny\n');
  assert.deepEqual(out, ['- one', '- two', '+ x', '+ y', '  ']);
});

test('writeIfAbsent: creates the file and its directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-scaffold-'));
  try {
    const dir = path.join(root, 'a', 'b');
    const file = path.join(dir, 'Dockerfile');
    writeIfAbsent(dir, file, 'FROM node');
    assert.equal(fs.readFileSync(file, 'utf8'), 'FROM node');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeIfAbsent: an identical existing file is left up to date, not rewritten', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-scaffold-'));
  try {
    const file = path.join(root, 'Dockerfile');
    fs.writeFileSync(file, 'FROM node', { mode: 0o600 });
    writeIfAbsent(root, file, 'FROM node');
    assert.equal(fs.readFileSync(file, 'utf8'), 'FROM node');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'mode preserved');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeIfAbsent: a divergent existing file is kept verbatim (never clobbered)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-scaffold-'));
  try {
    const file = path.join(root, 'Dockerfile');
    fs.writeFileSync(file, 'FROM old\n');
    writeIfAbsent(root, file, 'FROM new\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'FROM old\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});