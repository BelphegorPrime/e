# 24 - Composed run group: private network + one container MCP sidecar wired to Claude

**Status:** Done (closed 2026-08-08).

**GitHub:** [#13](https://github.com/BelphegorPrime/e/issues/13)

---

## What to build

**Type: HITL** — this reshapes the Runtime port from a single container to a composed group; the new port design should get a human review (ADR-0005 sets the direction).

Evolve the Runtime from one container into a **composed run group** (ADR-0005): create a private per-run network, start the selected **container MCP sidecars** (streamable HTTP), wait for readiness (TCP port + optional healthcheck from `mcp.json`), then start the primary agent; tear the whole group down with the worktree. `.e/mcp/<name>/` holds a `Dockerfile` + `mcp.json` (`transport`, `port`, `requiredEnv`); `e init` ships at least one and users can add their own. `e spawn <claude-agent> --mcp <name> "…"` wires Claude to `http://<name>:<port>` via `--mcp-config` (inline flag). Fail-fast if a requested sidecar never reaches readiness (before the agent starts); a mid-run sidecar crash is non-fatal (warning, like a failed push).

## Acceptance criteria

- [ ] Runtime port extended: bring up a group, wait on the primary agent, tear all down (agent → sidecars → network → worktree) in the existing `finally`.
- [ ] `.e/mcp/<name>/` schema (`Dockerfile` + `mcp.json`) defined; `e init` ships ≥1 container MCP server; MCP credentials injected into the sidecar, not the agent.
- [ ] `e spawn <claude-agent> --mcp <name> "…"`: sidecar built/started on a private network (streamable HTTP), Claude wired via `--mcp-config`, the MCP tool reachable end-to-end.
- [ ] Fail-fast before the agent when a sidecar misses readiness; a mid-run sidecar crash surfaces a warning without killing the run.
- [ ] The new Runtime-port design is reviewed (HITL); tests for lifecycle/failure semantics with a fake runtime; `npm test` passes.

## Blocked by

- #8
- #10
