// Bundles one TypeScript entry into a single dependency-free ESM script for a
// container (or an agent-side skill script): the container has no node_modules
// and no package.json, so cross-file imports must be inlined and anything but
// a `node:` built-in must fail the build loudly instead of being inlined
// unnoticed. Shared by scripts/build-egress-api.mjs and scripts/build-broker.mjs.

import { build } from 'esbuild';

/** Import specifiers in `code` that are not `node:` built-ins. */
export function nonNodeImports(code) {
  return [...code.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gm)]
    .map(m => m[1])
    .filter(spec => !spec.startsWith('node:'));
}

/**
 * Bundles `entry` and returns the script text. `what` names the bundle in the
 * error thrown when it would import anything but node built-ins.
 */
export async function bundleNodeOnly(entry, what) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    // Node built-ins only; anything else would silently be inlined into the
    // container script, so fail loudly instead.
    packages: 'external',
    legalComments: 'none',
  });
  const code = result.outputFiles[0].text;
  const external = nonNodeImports(code);
  if (external.length > 0) {
    throw new Error(
      `${what} bundle must only import node built-ins, found: ${external.join(', ')}`
    );
  }
  return code;
}
