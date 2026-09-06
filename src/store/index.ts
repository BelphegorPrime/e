/**
 * The **Store**: the `.e` directory holding e's on-disk state — the per-harness
 * Dockerfiles under `harnesses/`, the Agent definitions under `agents/`, the
 * container MCP server definitions under `mcp/`, the Skills under `skills/`, and
 * the shared `.env` base environment. The module owns the store's layout
 * ({@link paths}), its host-only state files ({@link config}), and the
 * root-finding walk that locates it ({@link root}). It knows nothing about the
 * Harness, Agent, MCP, or Skill registries, so the dependency runs one way:
 * `harness`/`agent`/`mcp`/`skill` → `store`.
 */
export * from './paths.js';
export * from './config.js';
export * from './root.js';