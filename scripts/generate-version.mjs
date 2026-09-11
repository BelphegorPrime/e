// Writes src/version.ts for a packaged build (`prebuild:version`). The version
// is, in order: an explicit E_VERSION env var (the release workflow sets it
// from the pushed tag), the exact git tag on HEAD with its `v` prefix
// stripped, the commit hash, or the 1.0.0 placeholder. restore-version.mjs
// puts the placeholder back after packaging.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** Picks the version string for this build; see the file header for the order. */
export function resolveVersion({ explicit, tag, hash, fallback = '1.0.0' }) {
  const candidate =
    explicit || (tag ? tag.replace(/^v/, '') : undefined) || hash;
  if (candidate === undefined) return fallback;
  if (!VERSION_RE.test(candidate)) {
    throw new Error(`Refusing to bake an unsafe version string: ${candidate}`);
  }
  return candidate;
}

/** The src/version.ts module text for `version`. */
export function versionModule(version) {
  return `export const E_VERSION = '${version}';\n`;
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf-8' });
  if (result.error || result.status !== 0) return undefined;
  const out = result.stdout.trim();
  return out === '' ? undefined : out;
}

async function main() {
  const version = resolveVersion({
    explicit: process.env.E_VERSION,
    tag: git(['describe', '--tags', '--exact-match', 'HEAD']),
    hash: git(['rev-parse', 'HEAD']),
  });
  await fs.writeFile('src/version.ts', versionModule(version));
  console.log(version);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
