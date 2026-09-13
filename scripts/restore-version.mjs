// Puts the 1.0.0 placeholder back into src/shared/version.ts after packaging,
// undoing generate-version.mjs. The path must match that script's: it wrote
// src/version.ts before the source tree was restructured, and this one was not
// moved with it - so every `build:bin` left the real module stamped with a
// commit sha and created a dead src/version.ts instead. VERSION_MODULE is
// shared with generate-version.mjs so the two cannot drift apart again.

import fs from 'node:fs/promises';
import { VERSION_MODULE, versionModule } from './generate-version.mjs';

await fs.writeFile(VERSION_MODULE, versionModule('1.0.0'));
