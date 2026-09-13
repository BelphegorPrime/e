// Puts the 1.0.0 placeholder back into src/shared/version.ts after packaging,
// undoing generate-version.mjs. The path must match that script's: it wrote
// src/version.ts before the source tree was restructured, and this one was not
// moved with it - so every `build:bin` left the real module stamped with a
// commit sha and created a dead src/version.ts instead. VERSION_MODULE is
// shared with generate-version.mjs so the two cannot drift apart again, and
// the CI build asserts the working tree is clean afterwards so a future
// mismatch fails the build instead of hiding in a commit.

import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { VERSION_MODULE, versionModule } from './generate-version.mjs';

/** The placeholder every non-packaging checkout carries. */
export const PLACEHOLDER_VERSION = '1.0.0';

/** Writes the placeholder back. `target` exists for tests; production uses the default. */
export async function restore(target = VERSION_MODULE) {
  await fs.writeFile(target, versionModule(PLACEHOLDER_VERSION));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await restore();
}
