import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderEnvFiles, decideImageAction } from './spawnPlan';

test('orderEnvFiles: no files when neither is present', () => {
  assert.deepEqual(orderEnvFiles(undefined, undefined), []);
});

test('orderEnvFiles: base only', () => {
  assert.deepEqual(orderEnvFiles('/root/.e/.env', undefined), ['/root/.e/.env']);
});

test('orderEnvFiles: user file only', () => {
  assert.deepEqual(orderEnvFiles(undefined, '/tmp/my.env'), ['/tmp/my.env']);
});

test('orderEnvFiles: base first, user file second (user overrides base)', () => {
  // Order is the contract: later --env-file entries override earlier ones for
  // the same key, so the user's file must come after the base .e/.env.
  assert.deepEqual(orderEnvFiles('/root/.e/.env', '/tmp/my.env'), [
    '/root/.e/.env',
    '/tmp/my.env',
  ]);
});

// decideImageAction truth table over (rebuild, imageExists, initialized).
// need-build = rebuild || !imageExists; then initialized ? 'build' : 'not-initialized'.
const cases: Array<{
  rebuild: boolean;
  imageExists: boolean;
  initialized: boolean;
  expected: 'skip' | 'build' | 'not-initialized';
}> = [
  { rebuild: false, imageExists: false, initialized: false, expected: 'not-initialized' },
  { rebuild: false, imageExists: false, initialized: true, expected: 'build' },
  { rebuild: false, imageExists: true, initialized: false, expected: 'skip' },
  { rebuild: false, imageExists: true, initialized: true, expected: 'skip' },
  { rebuild: true, imageExists: false, initialized: false, expected: 'not-initialized' },
  { rebuild: true, imageExists: false, initialized: true, expected: 'build' },
  { rebuild: true, imageExists: true, initialized: false, expected: 'not-initialized' },
  { rebuild: true, imageExists: true, initialized: true, expected: 'build' },
];

for (const { rebuild, imageExists, initialized, expected } of cases) {
  test(`decideImageAction: rebuild=${rebuild} imageExists=${imageExists} initialized=${initialized} -> ${expected}`, () => {
    assert.equal(
      decideImageAction({ rebuild, imageExists, initialized }),
      expected,
    );
  });
}
