# ADR-0011: Global Egress Blacklist via Shared Network Namespace

**Status:** Accepted
**Date:** 2026-09-06

**Related:** [ADR-0005 (container groups)](./0005-runs-as-composed-container-groups.md), [ADR-0006 (config adapter)](./0006-per-harness-config-adapter.md), [Attack Surface](../security/attack-surface.md)

## Decision

The local Compose stack owns **one global `e-egress` container**. OmniRoute,
Redis, optional local inference, the agent, and container MCP sidecars use its
network namespace where required. The agent and MCP sidecars are launched with:

```text
--network container:e-egress
```

Compose services use:

```yaml
network_mode: 'service:egress'
```

The egress container remains trusted and owns `NET_ADMIN`, dnsmasq, iptables,
blacklist mounts, and host-visible logs. It connects to `e-net`; services
sharing its namespace inherit that connectivity. There is no per-run egress
container, per-run egress lifecycle, or per-run egress network namespace.

Container MCP servers listen on dynamically selected loopback ports. Their
configured port is preferred; if occupied by another selected MCP or requested
agent port, `e` selects a free port from `31000-31999`. Agent MCP configuration
uses `http://localhost:<allocated-port>/mcp` when sharing the global namespace.

## Rationale

A global gateway matches the local Compose lifecycle, avoids starting one
privileged monitor per run, centralizes blacklist/logging policy, and lets all
local services use one stable namespace. MCP ports must be unique because
namespace sharing removes Docker DNS isolation: every service binds the same
loopback interface.

## Blacklist and enforcement

Two host-editable policy files are bind-mounted into the egress container and
seeded by `e init` (never clobbered): `.e/egress-blacklist` (dnsmasq
`address=` directives; `dnsmasq` sinkholes those domains and their subdomains)
and `.e/egress-iptables.rules` (a `sh` script of `iptables -A EGRESS ...`
rules the entrypoint applies into its own netns, for direct-IP destinations
that bypass DNS; it ships with comments only). The global service is trusted;
the agent receives no `NET_ADMIN` capability and cannot edit the mounted
policy. Both files are re-applied on `SIGHUP` to the egress container
(`docker kill -s HUP e-egress`), which restarts dnsmasq and re-runs the rules
script; the egress API (ADR-0012) sends that signal after each blacklist
mutation.

## Consequences

- One egress image/container per local stack; no per-run startup or teardown.
- Egress logs are global and need run correlation from container/runtime logs.
- A global egress failure affects all attached agents and MCPs.
- MCP services sharing the namespace cannot use Docker aliases for agent access;
  they use loopback and dynamically allocated ports.
- Runs without the local stack retain normal runtime networking.

## Supersedes

This replaces the former per-run egress design. Older references to
`<run>-egress`, `startEgress`, per-run blacklist mounts, and per-run egress logs
are historical and must not be used for new implementation work.
