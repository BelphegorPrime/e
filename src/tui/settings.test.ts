import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MenuCancelledError } from './settings.js';

test('MenuCancelledError: carries the menu abort message', () => {
  const err = new MenuCancelledError();
  assert.ok(err instanceof Error);
  assert.ok(err instanceof MenuCancelledError);
  assert.equal(err.name, 'MenuCancelledError');
  assert.equal(err.message, 'Settings menu cancelled.');
});