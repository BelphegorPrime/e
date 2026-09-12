import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selfInvocation } from './selfInvoke.js';

test('selfInvocation under plain Node passes the entry script again', () => {
  assert.deepEqual(
    selfInvocation(
      ['/usr/bin/node', '/workspace/dist/index.js', 'serve'],
      false
    ),
    { command: '/usr/bin/node', prefix: ['/workspace/dist/index.js'] }
  );
});

test('selfInvocation in a single-executable drops the snapshot entry path', () => {
  assert.deepEqual(
    selfInvocation(
      ['/usr/local/bin/e', '/snapshot/e/dist/index.js', 'serve'],
      true
    ),
    { command: '/usr/local/bin/e', prefix: [] }
  );
});

test('selfInvocation defaults to this process (not a single-executable under the test runner)', () => {
  const invocation = selfInvocation();
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.prefix, [process.argv[1]]);
});
