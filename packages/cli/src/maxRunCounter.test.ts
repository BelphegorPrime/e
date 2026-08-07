import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maxRunCounter } from './runSpawn';

const prefix = 'e/claudeCode/fix-parser';

test('returns 0 when no branch matches', () => {
  assert.equal(maxRunCounter([], prefix), 0);
  assert.equal(maxRunCounter(['e/claudeCode/other-1'], prefix), 0);
});

test('takes the max counter across matching local branches', () => {
  assert.equal(
    maxRunCounter([`${prefix}-1`, `${prefix}-3`, `${prefix}-2`], prefix),
    3,
  );
});

test('considers remote-tracking refs', () => {
  assert.equal(
    maxRunCounter([`${prefix}-1`, `origin/${prefix}-4`], prefix),
    4,
  );
});

test('ignores a longer slug that shares this prefix', () => {
  // e/claudeCode/fix-parser-fast-2 belongs to slug "fix-parser-fast", not "fix-parser".
  assert.equal(maxRunCounter([`${prefix}-fast-2`, `${prefix}-1`], prefix), 1);
});

test('ignores non-numeric suffixes', () => {
  assert.equal(maxRunCounter([`${prefix}-wip`, `${prefix}-2`], prefix), 2);
});
