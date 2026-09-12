# 25 - Remote-transport MCP servers

**Status:** Done (closed 2026-08-08).

**GitHub:** [#14](https://github.com/BelphegorPrime/e/issues/14)

---

## What to build

Support an MCP server whose `mcp.json` declares `transport: remote` (a hosted URL, no container) per ADR-0006. Selecting such a server with `--mcp <name>` wires the agent's MCP client directly to the URL (Claude via `--mcp-config`), with auth pulled from `.e/.env`; no sidecar or private-network entry is created for it. Container and remote MCP servers are selected the same way (by name) — the manifest's `transport` decides the mechanism.

## Acceptance criteria

- [ ] `mcp.json` accepts `transport: remote` with `url` + `requiredEnv`; no Dockerfile required.
- [ ] `--mcp <remote-name>` wires the agent to the URL end-to-end (Claude), auth from `.e/.env`, no sidecar started.
- [ ] Mixed selection (`--mcp remoteOne,containerTwo`) brings up only the container one as a sidecar.
- [ ] Tests for remote wiring and mixed selection; `npm test` passes.

## Blocked by

- #13
