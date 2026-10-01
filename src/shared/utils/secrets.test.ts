import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_SECRET_LENGTH, secretsToRedact } from './secrets.js';

const KEY = 'sk-test-0123456789abcdef';

test('secretsToRedact: unique, long enough to be a secret, longest first', () => {
  assert.deepEqual(
    secretsToRedact([KEY, undefined, '', '1', 'true', KEY, `${KEY}-longer`]),
    [`${KEY}-longer`, KEY]
  );
  assert.equal(MIN_SECRET_LENGTH, 8);
});
