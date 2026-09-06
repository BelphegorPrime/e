# A Run is a host-orchestrated group of containers on a private network

Extending ADR-0001 and ADR-0002, a Run is no longer a single container. It is a **primary agent container** plus zero or more per-run **Sidecars** — container-transport MCP servers today, a VPN later — on a private per-run network, all brought up and torn down by the host `e` process. Sidecars are chosen per-run (`--mcp <name>…`), never baked into the agent.

Lifecycle: create the private network → start sidecars → wait for readiness (TCP port open within a timeout, plus an optional healthcheck declared in the MCP server's `mcp.json`) → start the agent. The agent is the primary: its exit ends the Run.

Failure semantics mirror the patterns already in `runSpawn`:

- A requested sidecar that never reaches readiness **aborts the Run before the agent starts** — fail-fast, like the existing not-a-repo / not-initialized checks. No worktree commit, no branch push.
- A sidecar that **crashes mid-run is non-fatal**: the agent keeps working and the failure is surfaced as a warning, exactly as a failed push is today — because the primary may hold uncommitted work, and killing it would violate the never-lose-work line of ADR-0002.

Teardown is group-wide in the same `finally` that already drops the worktree: agent → sidecars → network → worktree.

## Considered Options

- **Single container, MCP servers as in-image processes** — rejected: re-explodes the image matrix (agent × mcp-set), couples lifecycles, and cannot host a VPN container.
- **A general compose/orchestration engine (Compose, Kubernetes)** — deferred: the existing thin Runtime port plus a runtime network primitive and a tracked list of container names is enough; adopting a compose engine is a heavier commitment we don't need yet.

## Consequences

- The Runtime port grows from "run one container" to "bring up a group, wait on the primary, tear all down."
- Container-transport MCP servers must speak **streamable HTTP** — stdio cannot cross a container boundary, and SSE is deprecated in Claude Code and unsupported by Codex — so stdio-only servers are wrapped with a stdio→HTTP bridge inside their sidecar image (ADR-0006).
- VPN / egress routing is a future sidecar; it intersects the deferred egress-hardening gap in ADR-0002 and gets its own decision.
