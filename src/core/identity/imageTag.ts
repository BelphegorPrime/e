/**
 * **Image identity** - the `e-<kind>-<name>` convention shared by harness base
 * images, derived agent images, and MCP sidecar images. One rule, one place,
 * instead of a literal per harness plus a function per other kind.
 *
 * This module imports nothing - the names are its whole implementation.
 */

/** The kinds of image `e` tags, each namespaced so tags never collide across kinds. */
export type ImageKind = 'harness' | 'agent' | 'mcp';

/**
 * The image tag for a `kind`/`name` pair: `e-<kind>-<name>`, lowercased because
 * container image references must be lowercase (so the harness `claudeCode`
 * becomes `e-harness-claudecode`). The `e-harness-*` / `e-agent-*` / `e-mcp-*`
 * namespaces keep a harness, agent, and sidecar image from ever colliding.
 */
export function imageTag(kind: ImageKind, name: string): string {
  return `e-${kind}-${name.toLowerCase()}`;
}
