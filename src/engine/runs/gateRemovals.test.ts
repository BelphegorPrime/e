import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryGit } from '../../ports/git/memory.js';
import { DEFAULT_VERIFY_GUARDS } from '../../core/store/config.js';
import {
  describeGateRemovals,
  gateRemovalsOf,
  measureGateRemovals,
} from './gateRemovals.js';

test('gateRemovalsOf: removals count, additions never do, an in-set rename is nothing, a binary is not counted', () => {
  assert.deepEqual(
    gateRemovalsOf([
      // A git mv out of the guarded set: the source's full removal.
      { path: 'src/a.test.ts', added: 0, removed: 3 },
      // New tests touch the same files and remove nothing.
      { path: 'tests/grow.ts', added: 12, removed: 0 },
      { from: 'tests/in.ts', path: 'tests/renamed.ts', added: 0, removed: 0 },
      { path: 'tests/weakened.ts', added: 1, removed: 1 },
      { path: 'tests/blob.bin', added: null, removed: null },
    ]),
    { files: 2, lines: 4 }
  );
  assert.deepEqual(gateRemovalsOf([]), { files: 0, lines: 0 });
});

test('measureGateRemovals: over base..tip, with the built-in test paths unless the Store names its own', () => {
  const git = new InMemoryGit({
    numstat: [{ path: 'tests/x.ts', added: 0, removed: 5 }],
  });
  assert.deepEqual(
    measureGateRemovals(git, 'base-sha', 'e/pi/x-1', undefined),
    {
      files: 1,
      lines: 5,
    }
  );
  measureGateRemovals(git, 'base-sha', 'e/pi/x-1', ['e2e/']);
  assert.deepEqual(git.numstats, [
    {
      base: 'base-sha',
      tip: 'e/pi/x-1',
      pathspecs: [...DEFAULT_VERIFY_GUARDS],
    },
    { base: 'base-sha', tip: 'e/pi/x-1', pathspecs: ['e2e/'] },
  ]);
});

test('measureGateRemovals: guards [] measures nothing and never asks git, whose empty pathspec is every file', () => {
  const git = new InMemoryGit({
    numstat: [{ path: 'src/app.ts', added: 0, removed: 99 }],
  });
  assert.deepEqual(measureGateRemovals(git, 'b', 't', []), {
    files: 0,
    lines: 0,
  });
  assert.deepEqual(git.numstats, []);
});

test('describeGateRemovals: files and removed lines, singular where it is one', () => {
  assert.equal(
    describeGateRemovals({ files: 2, lines: 47 }),
    '2 files, -47 lines'
  );
  assert.equal(describeGateRemovals({ files: 1, lines: 1 }), '1 file, -1 line');
});
