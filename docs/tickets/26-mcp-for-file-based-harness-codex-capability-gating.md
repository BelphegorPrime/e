# 26 - MCP for file-based harness (Codex) + capability gating (reject pi)

**Status:** Done (closed 2026-08-08).

**GitHub:** [#15](https://github.com/BelphegorPrime/e/issues/15)

---

## What to build

Deliver per-run MCP config to a file-based harness (**Codex**) via the runtime overlay: render the selected servers into a `[mcp_servers.*]` block merged onto the baked base config and delivered outside `/workspace` (via `CODEX_HOME`), using streamable HTTP for container sidecars. Enforce **capability gating**: a harness with no MCP client (**pi**) rejects `--mcp` with a clear message. This confirms the "adapter renders, delivery form per-harness" rule (ADR-0006) for the file path.

## Acceptance criteria

- [ ] The Codex adapter renders the selected MCP servers into its config (streamable HTTP for container sidecars) as a runtime overlay outside `/workspace`.
- [ ] `e spawn <codex-agent> --mcp <name> "…"` reaches the MCP tool end-to-end.
- [ ] Each Harness declares MCP capability; `e spawn pi --mcp …` errors clearly (gating).
- [ ] Tests for Codex MCP rendering and capability gating; `npm test` passes.

## Blocked by

- #11
- #13
