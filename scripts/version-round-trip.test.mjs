import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  VERSION_MODULE,
  resolveVersion,
  versionModule,
} from './generate-version.mjs';
import { PLACEHOLDER_VERSION, restore } from './restore-version.mjs';

/**
 * The bug this guards: `generate-version.mjs` stamps a real version into a
 * tracked source file during packaging, and `restore-version.mjs` is the only
 * thing that puts the placeholder back. They once named different paths, so
 * every `build:bin` left the real module stamped with a commit sha and created
 * a dead file beside it - visible to nobody until someone committed it.
 */

test('both scripts name one module, so they cannot drift apart', () => {
  // A literal path in either script - the original mistake - fails here.
  assert.equal(VERSION_MODULE, 'src/shared/version.ts');
  assert.match(
    VERSION_MODULE,
    /^src\//,
    'it is tracked source, not a build output'
  );
});

test('restore puts back exactly what an unpackaged checkout carries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e-version-'));
  const target = path.join(dir, 'version.ts');
  try {
    // Packaging stamps a real version...
    await fs.writeFile(target, versionModule('1.4.2'));
    // ...and the restore has to undo it byte for byte.
    await restore(target);
    assert.equal(
      await fs.readFile(target, 'utf8'),
      versionModule(PLACEHOLDER_VERSION)
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the checked-in module is the placeholder, not a stamped build', async () => {
  // If this fails, a packaging build was committed: run
  // `node scripts/restore-version.mjs` and commit that.
  assert.equal(
    await fs.readFile(VERSION_MODULE, 'utf8'),
    versionModule(PLACEHOLDER_VERSION)
  );
});

test('a version that could break out of the string literal is refused', () => {
  // The stamped value is interpolated into source, so it is checked first.
  for (const unsafe of ["1.0.0'; process.exit(1); //", '1.0.0\n', 'a b']) {
    assert.throws(
      () => resolveVersion({ explicit: unsafe }),
      /Refusing to bake an unsafe version string/
    );
  }
  assert.equal(resolveVersion({ explicit: '1.4.2' }), '1.4.2');
  assert.equal(resolveVersion({ tag: 'v2.0.0-rc.1' }), '2.0.0-rc.1');
});
