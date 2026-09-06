# ADR-0011: Egress Blacklist via Shared Network Namespace

**Status:** Accepted  
**Date:** 2026-09-06  
**Deciders:** System design  
**Related:** [ADR-0005 (Sidecar MCP)](./0005-sidecar-mcp.md), [ADR-0006 (Store layout)](./0006-store-layout.md), [Attack Surface](../security/attack-surface.md)

## Context

Every `e spawn` run executes untrusted LLM-generated code inside a disposable container. The harness agent has full network access by default — it can phone home, exfiltrate credentials, or reach any network-reachable service. While the worktree is ephemeral and credentials are scoped (ADR-0006 Zone 2), nothing prevents an agent from opening a raw socket to `example.com:443` or `203.0.113.9:8443` and sending data.

We need **egress monitoring with blacklist enforcement** — log every DNS query and connection attempt, and block named destinations (domains + IP:port pairs) before they leave the host. The solution must:

- **Enforce before the agent socket opens**: DNS sinkholing and IP REJECTs must happen in the same network namespace the agent uses, so bypassing DNS (direct-IP connections) still hits the firewall.
- **Never trust the agent**: The agent must not be able to flush iptables rules, edit the blacklist, or disable the monitor. Capabilities (`NET_ADMIN`) must stay outside the untrusted container.
- **Log everything**: Every DNS query and forwarded connection must be recorded to a host-visible mount, so an operator can audit what the agent tried to reach.
- **Host-editable blacklist**: The blacklist source lives in the store (`.e/egress-blacklist`), never baked into an image, so an operator can add `evil.com` and reload without rebuilding.
- **Minimal blast radius**: One egress container per run, not a shared daemon. A crash affects only that run's agent, and teardown is idempotent.

### Rejected Alternatives

1. **Outbound proxy (Squid, Envoy)**: Requires configuring `HTTP_PROXY`/`HTTPS_PROXY` in the agent, which LLM code can unset. CONNECT tunnels are opaque (no domain visibility after handshake). Direct-IP connections bypass the proxy entirely.

2. **`--network=none` + whitelist**: Removes all connectivity, including sidecar reachability and `host.docker.internal` (the local OmniRoute stack). Whitelisting every allowed destination is brittle — every new API the agent needs breaks the run.

3. **Host-level iptables rules**: Shared across all containers on the host. A typo in a rule could block the operator's SSH or break other services. Teardown is non-atomic (one failed `iptables -D` leaves the chain half-removed).

4. **BPF egress hook**: Requires kernel ≥5.7, `CAP_BPF`, and compiling/loading a program per run. The DNS extraction is fragile (DNS-over-HTTPS bypasses it), and the operator UX ("view this bpftool dump") is hostile compared to plaintext logs.

## Decision

Every run starts **one egress container** (`<run>-egress`) with:

- **Alpine base + dnsmasq + iptables**: The image is `e-egress`, seeded by `e init` into `.e/egress/` (Dockerfile + entrypoint + base dnsmasq.conf). Never clobbered, so the operator can edit the image (e.g., add `tcpdump`).
- **`NET_ADMIN` capability**: The egress container applies iptables REJECT rules in its own netns at startup. The harness agent shares the netns (`--network container:<run>-egress`) but inherits no capabilities — it cannot flush rules or disable enforcement.
- **Mounted blacklist files**: The store's `.e/egress-blacklist` is parsed into two rendered files at spawn time:
  - `dnsmasq.blacklist` (DNS sinkhole rules: `address=/domain/0.0.0.0`)
  - `iptables.rules` (REJECT script for IP:port pairs, only when present)
  
  Both are mounted read-only (iptables) or read-write (dnsmasq, for `SIGHUP` reloads). The entrypoint applies them and traps `SIGHUP` to re-apply without restarting the netns.
- **Loopback DNS forced (`--dns 127.0.0.1`)**: The egress container's `resolv.conf` points to its own dnsmasq, and the agent inherits it through the shared netns. The engine's embedded DNS (Docker: `127.0.0.11`, Podman: aardvark) becomes dnsmasq's upstream, so sidecar aliases and `host.docker.internal` still resolve while every query is logged/sinked here first.
- **Dedicated `EGRESS` iptables chain**: The entrypoint creates `-N EGRESS`, hooks it into `OUTPUT` once, then flushes and re-applies the chain on reload. This preserves the engine's own netns rules (the embedded-DNS path Docker wires in) and never clobbers them with `-F OUTPUT`.
- **Query and connection logs**: `dnsmasq --log-queries` writes to a mounted `/var/log/egress/dnsmasq.log`; iptables REJECT events appear in the container's stderr (visible in `docker logs <run>-egress`).

### Runtime Lifecycle

1. **Planning (`planSpawn`)**: `egressEnabled = (root !== undefined)` — any spawn with a store root gets the egress monitor. The executor uses `egressEnabled` to gate the image build and mount materialization.
   
2. **Image build (`buildImages`)**: When `egressEnabled && isEgressInitialized(root)`, build the `e-egress` image from `.e/egress/`. This happens before the worktree exists (ADR-0005), alongside harness and sidecar images.

3. **Mount materialization (`executeSpawn`)**: Parse `.e/egress-blacklist` into `{ domains, ipPorts }`, render `dnsmasq.blacklist` and (optionally) `iptables.rules` into a scratch dir, and pass the host paths as an `EgressPlan` to the orchestrator.

4. **Orchestration (`runSpawn`)**:
   - **Group order**: `createNetwork` (when sidecars exist) → `startEgress` → `startSidecar` → `probeTcp` (readiness) → agent (with `--network container:<run>-egress`, no networks of its own).
   - The egress container joins the networks the agent used to (the run's private network when sidecars exist, the compose edge network `omniroute-edge` when the local stack is present, and always the default `bridge` WAN face).
   - The agent gets `netns: run.egressContainer`, which replaces `networks` entirely (mutually exclusive, `netns` wins at argv-build time).
   - **Liveness check**: After the agent returns, `runtime.isRunning(run.egressContainer)`. A crash is non-fatal (the agent may hold uncommitted work) but explicitly warned: `"Egress monitor exited during the run; the agent lost its network namespace (its egress and DNS were cut off)."` (Verify item 4 from the ticket).
   - **Teardown**: `removeContainer(<run>-egress)` in the `finally` block, best-effort (a throw never masks the run result). The egress log dir is ephemeral (a temp dir per run); logs disappear when the container is removed unless the operator tails them during the run.

5. **Naming (`src/identity/naming.ts`)**: `RunName.egressContainer = <name>-egress`, e.g., `e-demo-fix-1-egress`.

### Blacklist Format

The store's `.e/egress-blacklist` is line-oriented plaintext (never JSON, never YAML — an operator edits it by hand):

```
# Lines starting with # or ; are comments. Blank lines are ignored.
# A line with an IPv4:port pattern (e.g., 203.0.113.9:8443) is an IP rule.
# Anything else is treated as a domain (normalized to lowercase, leading/trailing dots stripped).

# Block example.com and all subdomains (api.example.com, a.b.example.com).
example.com

# Block direct-IP connections to a known-bad server on port 8443.
203.0.113.9:8443

# IPv6 is not yet supported (no `:` separator ambiguity solution).
```

**Rendering**:
- `parseBlacklist(content)` → `{ domains: string[], ipPorts: string[] }`
- `renderDnsmasqConf(domains)` → `address=/example.com/0.0.0.0\n...` (Pi-hole semantics: domain + subdomains)
- `renderIptablesRules(ipPorts)` → `iptables -A EGRESS -d 203.0.113.9 -p tcp --dport 8443 -j REJECT --reject-with icmp-port-unreachable\n...`

**Reload**: The operator edits `.e/egress-blacklist`, then `docker kill -s HUP <run>-egress`. The entrypoint's trap re-applies both files without restarting the netns (the agent's sockets stay open). Restart is non-atomic (DNS/iptables inconsistent for ~100ms), but safe — the agent never gains access it didn't have.

### Enforcement Boundaries

- **DNS sinkhole**: Queries for `example.com` (and `*.example.com`) resolve to `0.0.0.0`, so the agent's connection attempt fails fast with `ECONNREFUSED`. Dnsmasq logs the query regardless of sinkhole vs. forwarded.
- **IP REJECT**: Direct-IP connections (bypassing DNS) hit iptables on the OUTPUT path: `iptables -A EGRESS -d 203.0.113.9 -p tcp --dport 8443 -j REJECT --reject-with icmp-port-unreachable`. The agent gets `ICMP port unreachable`, distinct from a silent drop, and the connection fails before any data leaves the netns.
- **Upstream forwarding**: Non-blacklisted domains are forwarded to the engine's embedded DNS (`server=127.0.0.11` in the dnsmasq base config), which resolves sidecar aliases, `host.docker.internal`, and external names normally.

### Security Properties

1. **Agent cannot disable enforcement**: `NET_ADMIN` stays on the egress container. The agent shares the netns but inherits no capabilities. Even `docker exec <agent> iptables -F` fails (`Operation not permitted`).
2. **No blacklist tampering**: The dnsmasq blacklist mount is in the egress container's `/etc/egress.d/`, not visible to the agent at all. The iptables script is also egress-only.
3. **No DNS inheritance bypass**: The agent's `resolv.conf` is managed by Docker/Podman and points to the shared netns's loopback interface (`127.0.0.1`), where dnsmasq listens. The agent cannot overwrite `/etc/resolv.conf` (it's a bind mount).
4. **No embedded-DNS collision**: Dnsmasq binds `127.0.0.1:53` (`bind-interfaces` + `listen-address=127.0.0.1`), never `127.0.0.11`. The engine's embedded DNS coexists in the same netns and becomes dnsmasq's upstream.

### Verify Before Merge (from Ticket)

1. **DNS inheritance**: Agent `cat /etc/resolv.conf` → `nameserver 127.0.0.1`. Agent `dig example.com` → `0.0.0.0` (sinked). Agent `dig google.com` → real IP (forwarded via 127.0.0.11 upstream). ✅
2. **Embedded DNS still works**: With sidecars, agent `dig everything` (sidecar alias) → `<run-net IP>`. Agent `dig host.docker.internal` → gateway IP. ✅
3. **Engine parity (Docker + Podman)**: Both use loopback embedded DNS (Docker: 127.0.0.11, Podman: aardvark at 127.0.0.1 when user networks exist). Dnsmasq's bind-interfaces + loopback-only listen avoids collision. ✅
4. **Egress liveness**: If the egress container crashes mid-run, the agent loses its network namespace (its interfaces disappear). `runSpawn` checks `isRunning(egressContainer)` after the agent returns and surfaces an explicit warning when it's down. ✅

## Consequences

### Positive

- **Blocks before sockets open**: DNS sinkholing and IP REJECTs happen in the same netns the agent uses, so the agent cannot bypass enforcement.
- **Untrusted agent, trusted egress**: Capabilities stay outside the untrusted container. The agent shares the netns but cannot disable rules.
- **Host-editable blacklist**: Operators add `evil.com` to `.e/egress-blacklist` and reload with `SIGHUP`, no rebuild.
- **Query audit log**: Every DNS query is recorded, regardless of sinkhole vs. forwarded. Direct-IP REJECT events appear in `docker logs`.
- **Minimal blast radius**: One egress container per run. A crash affects only that run's agent; teardown is idempotent.
- **Compose stack still works**: `host.docker.internal` and sidecar aliases resolve normally via the embedded-DNS upstream.

### Negative

- **Per-run overhead**: Starting `<run>-egress` adds ~100ms to spawn time (Alpine boot + dnsmasq + iptables apply). Mitigated: the image is built once and cached.
- **Log ephemeral unless tailed**: The egress log dir is a temp dir; it disappears when the container is removed. An operator must `tail -f` or redirect logs during the run to preserve them.
- **Blacklist not allowlist**: Everything *not* blacklisted is reachable. An operator who wants zero-trust WAN access must list every external destination (brittle). The ticket chose "blacklist known-bad" over "allowlist known-good" because the latter breaks every new API the agent needs.
- **IPv6 unsupported**: The `:` separator is ambiguous in `2001:db8::1:8443` (IP or IP:port?). The parser skips IPv6 lines. IPv6 egress is rare in 2026 dev environments; adding it requires a `[2001:db8::1]:8443` format.
- **Reload is non-atomic**: `SIGHUP` re-applies dnsmasq + iptables sequentially (~100ms inconsistency). The agent never gains access it didn't have, but a query mid-reload might resolve before the new sinkhole applies.

### Follow-up Work

1. **Persistent logs**: Add a `--egress-log-dir <path>` flag to materialize logs into a host dir that survives teardown.
2. **IPv6 support**: Adopt `[<ip>]:<port>` syntax for IPv6:port, or a dedicated `ipv6:` prefix line.
3. **Allowlist mode**: Add a `ALLOWED_DOMAINS` escape hatch for zero-trust environments (everything not listed is REJECT/sinkholed). Requires inverting the dnsmasq logic (blocklist → `address=/blocked/0.0.0.0`, allowlist → `address=/#/0.0.0.0` + per-domain forwards).
4. **Egress dashboard**: A live TUI that tails the egress log and shows DNS queries + REJECT events in real time during a run.

## References

- [Ticket: Egress Blacklist (DNS + IP)](../security/egress-blacklist-ticket.md)
- [Attack Surface: Zone 1 item 4](../security/attack-surface.md) (updated with egress monitor)
- [ADR-0005: Sidecar MCP Servers](./0005-sidecar-mcp.md) (network namespace orchestration)
- [ADR-0006: Store Layout and Env Layering](./0006-store-layout.md) (host-editable `.e/egress-blacklist`)
- Implementation files:
  - `src/egress/index.ts` — pure parse/render functions
  - `src/init/renderEgress.ts` — Dockerfile + entrypoint + dnsmasq.conf templates
  - `src/runtime/index.ts` — `egressRunArgs()`, `startEgress()`
  - `src/runs/runSpawn.ts` — orchestration (egress lifecycle, netns wiring, liveness)
  - `src/spawn/executeSpawn.ts` — image build + mount materialization
  - `src/spawn/spawnPlan.ts` — `egressEnabled` flag
