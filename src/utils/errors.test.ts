import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorMessage } from './errors.js';

test('errorMessage: an Error gives its message, anything else its string form', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage(new TypeError('typed')), 'typed');
  assert.equal(errorMessage('a thrown string'), 'a thrown string');
  assert.equal(errorMessage(42), '42');
  assert.equal(errorMessage(undefined), 'undefined');
  assert.equal(errorMessage({ code: 'E' }), '[object Object]');
});
