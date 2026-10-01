import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../greet.js';

test('greet says hello to anyone', () => {
  assert.equal(greet('Ada'), 'Hello, Ada!');
  assert.equal(greet('Grace Hopper'), 'Hello, Grace Hopper!');
  assert.equal(greet('Zoë'), 'Hello, Zoë!');
});
