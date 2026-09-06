import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localStack } from './stack.js';

// The stack predicate is a filesystem probe, so these tests build a real `.e`
// fixture in a temp dir and assert on the resolved paths.

function tmpStore(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-stack-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('localStack: an unknown root is not a stack at all', () => {
  assert.equal(localStack(undefined), undefined);
});

test('localStack: no compose file means no stack, but the paths still resolve', () => {
  const { root, cleanup } = tmpStore();
  const stack = localStack(root);
  assert.ok(stack);
  assert.equal(stack.present, false);
  assert.equal(stack.envFile, undefined);
  assert.ok(stack.composeFile.endsWith(path.join('.e', 'compose.yaml')));
  cleanup();
});

test('localStack: a compose file is the stack-present predicate', () => {
  const { root, cleanup } = tmpStore();
  fs.mkdirSync(path.join(root, '.e'));
  fs.writeFileSync(path.join(root, '.e', 'compose.yaml'), 'services: {}\n');
  const stack = localStack(root);
  assert.equal(stack?.present, true);
  assert.ok(stack?.composeFile.endsWith(path.join('.e', 'compose.yaml')));
  cleanup();
});

test('localStack: .env presence is reported for the compose env-file flag', () => {
  const { root, cleanup } = tmpStore();
  fs.mkdirSync(path.join(root, '.e'));
  fs.writeFileSync(path.join(root, '.e', '.env'), 'A=1\n');
  fs.writeFileSync(path.join(root, '.e', 'compose.yaml'), 'services: {}\n');
  const stack = localStack(root);
  assert.equal(stack?.present, true);
  assert.ok(stack?.envFile?.endsWith(path.join('.e', '.env')));
  cleanup();
});