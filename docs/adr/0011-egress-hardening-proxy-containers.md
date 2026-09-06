# Run egress is an allow-list enforced by proxy containers on an internal run network

ADRs 0001 and 0002 accepted full container egress as a deferred gap: the agent
must reach its provider's model API, so the container could reach anything
else, too (`docs/security/attack-surface.md`, Zone 1). This ADR closes that gap
for every provider-backed run: the agent's egress is reduced to the planned
provider base URL plus the run's configured remote MCP endpoints, enforced
with **per-host transparent TCP proxy containers on an `--internal` run
network** — Docker has no native per-container egress firewall, and the
alternatives break the harnesses.

## Mechanism

The run's private network (ADR-0005) is created `--internal` when the run has
an egress allow-list, so nothing on it can reach the outside world — not the
agent, not the sidecars, not the proxies. Egress happens only through proxy
containers attached to that network *and* a WAN-capable one (the default
bridge, or the compose edge network for local stack services):

- **One proxy per allow-listed host.** It listens on the run network at the
  endpoint's own hostname (network alias) and port, and forwards each byte to
  the real `host:port` from its WAN face. The agent's URLs are unchanged: the
  endpoint hostname resolves (embedded DNS) to the proxy's run-network IP, the
  proxy holds the allow-list, and the agent's only reachable WAN is the set of
  listed `host:port` pairs. TLS is untouched (a byte-level forward), so
  certificate validation and `https://` providers behave exactly as before.
- **Sidecars keep WAN when the network is internal.** A container MCP server
  may need external APIs (e.g. a GitHub server), so sidecars join the default
  bridge alongside the internal run network; sidecar-to-sidecar traffic stays
  on the run network, unchanged.
- **The local compose stack keeps working.** The default agent's provider URL
  (`http://host.docker.internal:20128`) is the provider base URL, so
  `host.docker.internal` is allow-listed like any other host. Its proxy joins
  the `omniroute-edge` network instead of the bridge, where the existing
  compose alias resolves `host.docker.internal` straight to the OmniRoute
  container (Zone 3) — no host hop, no loopback-bound-port problem. The agent
  itself never joins `omniroute-edge`, so it loses the accidental WAN route
  that edge membership gave it.
- **Upstream addresses are pinned at spawn.** A proxy must not resolve its own
  alias (it would forward to itself), so the executor resolves each public host
  to an IP host-side and hands the proxy the IP. `host.docker.internal` is the
  one literal: the proxy resolves it via the edge network's compose DNS.
- **A hardened run is a networked run.** The agent joins only the internal run
  network (never the default bridge, never `omniroute-edge`) and the
  `host-gateway` mapping is dropped, so there is no second route out.

## Considered Options

- **A general forward proxy on the run network (CONNECT proxy, e.g. tinyproxy)
  with `HTTP_PROXY`/`HTTPS_PROXY`.** Rejected: the harnesses do not reliably
  honor proxy env vars. Claude Code's underlying Node fetch does not use them
  by default, Codex (Rust/reqwest) does not either, and pi is Node — forcing
  traffic through a CONNECT proxy would break every harness, violating this
  ADR's second constraint. Per-host transparent forwarders need no client
  cooperation: the agent keeps making its normal direct HTTPS requests.
- **A network-policy layer (compose network driver, CNI).** Rejected: the
  runtime seam is the thin docker/podman CLI (ADR-0005 deferred a compose
  engine itself); neither driver exposes per-container egress policy, and
  adopting a CNI/policy layer is a heavier commitment than the gap warrants.
- **Do nothing (status quo).** Rejected: the whole point. Full egress lets a
  compromised agent scan, reach the host LAN, and exfiltrate to arbitrary
  destinations; the allow-list leaves only the endpoints the run is declared
  to use (and those are the endpoints with which the attacker's compromise
  was always moot — the agent talks to them by design).

## Consequences

- **Provider-backed runs are locked down by default.** An allow-list exists
  whenever the agent has a provider or a remote MCP server, so the internal
  network and proxies are brought up automatically; a bare run with neither
  keeps the historical default-bridge behavior (there is nothing to preserve).
- **Deliberately-broken things.** DNS for non-listed hosts still resolves (the
  embedded DNS forwards), but the connect fails — no route. Harness startup
  calls outside the allow-list (update checks, telemetry) hang or fail rather
  than silently succeeding; that is the hardening, and CLI failures surface as
  timeouts. Image *builds* are unaffected — builds run in the daemon's own
  build namespace with their own egress, so `npx skills@latest` at build time
  keeps working.
- **Rip-cordable.** The mechanism is one flag deep in the executor (`egress`
  plans), so reverting to full egress is a plan-level decision, not a network
  re-architecture.
- **Wrinkle: `host.docker.internal` without the local stack.** A provider
  pointed at `host.docker.internal` with no compose stack was already broken
  (OmniRoute binds `127.0.0.1`, unreachable over the bridge gateway anyway);
  the proxy path fails loudly at spawn (unresolvable upstream) rather than
  silently, and the real fix is the stack. The hardened proxy uses the same
  `host-gateway` mapping the agent used to get in this case, so no regression.
- **Egress proxy image.** A tiny static image (Alpine + `socat`) built once
  and cached as `e-egress`, like the mcp sidecar images.