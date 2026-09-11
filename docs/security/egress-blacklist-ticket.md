# Ticket: Egress blacklist monitor via a shared-network-namespace egress container

> **Status: Done, superseded.** This ticket predates the rewrite of ADR-0011
> (now the global `e-egress` netns design) and ADR-0012 (the egress API). The
> code it cites (`src/egress/index.ts`, `deriveEgressAllowList`,
> `planEgressProxies`, `ALLOWED_DOMAINS`, per-run `<run>-egress` containers)
> no longer exists; see `src/egress/`, `src/init/renderEgress.ts` and
> `src/init/renderCompose.ts` for what shipped. Kept for history.

> Revision of the original egress-hardening ticket (whitelist, proxy-vs-policy
> decision). The whitelist approach shipped as ADR-0011 but is being inverted:
> the egress path becomes a blacklist **with full traffic monitoring written to
> a mounted log file**, enforced by a single container whose network namespace
> the harness agent shares.

## Problem

Agent containers have full network egress (ADR-0002 accepted this as a
deferred gap). ADR-0011 closed the gap with a whitelist: per-host transparent
`e-egress` proxy containers on an `--internal` run network, where the agent could
reach only enumerated `host:port` pairs. That works but is operationally
brittle:

- Every host the agent must reach has to be enumerated up front
  (`deriveEgressAllowList`). Unexpected destinations - a package mirror, a CDN,
  a redirect target, a random remote MCP endpoint - fail or hang.
- The pressure showed: `ALLOWED_DOMAINS` (npmjs, pypi, github, ...) had to be
  force-added to the allow-list in `spawnPlan.ts`, breaking the allow-list
  invariants its own tests assert.
- No traffic observability: when the agent does reach egress, nobody can see
  what it did.

The harness agent _needs_ its provider base URL and the configured MCP
endpoints; everything else _may_ be reached and should be **logged**, with only
known-bad destinations **blocked**.

## Approach (decision)

Replace the per-host whitelist proxies with **one egress container per run
whose network namespace the harness agent shares**:

- Compose form: `network_mode: "service:egress-proxy"`.
- CLI form (the runtime seam, ADR-0005): `docker run --network container:<egress>`
  / `podman run --network container:<egress>` - the agent is started with
  `--network container:<run>-egress` **after** the egress container is up.

The agent then has no interfaces of its own: every socket, every DNS query,
every connection physically crosses the egress container's netns. No client
cooperation (`HTTP_PROXY` is dead on arrival for these harnesses, ADR-0011
measured it), no host iptables, no default-route surgery, no
`NET_ADMIN`/`NET_RAW` on the untrusted agent (the egress container is ours and
trusted).

### Blacklist - Pi-hole style DNS sinkhole

- Egress container runs `dnsmasq` with a **mounted blacklist file**:
  `address=/blocked.example/0.0.0.0` (matches the domain and its subdomains).
  A blacklisted name resolves to the sinkhole IP, the agent's connection fails
  fast, and the attempt is logged. Default sinkhole `0.0.0.0` (Pi-hole
  default); optionally a local stub HTTP listener returning `404` at the
  sinkhole IP so blocked HTTP(S) attempts surface a definitive response and a
  log line.
- Non-DNS blacklist (direct-IP connections bypass DNS): `iptables` REJECT on
  the forwarded/output path in the egress netns for blacklisted IP:port pairs.
- No enumerated allow-list: everything not blacklisted is reachable by default.

### Monitoring - mounted log file

- `dnsmasq` logs every query (timestamp, source, qname, action) - this is the
  "all requests a harness is trying" record, Pi-hole style.
- `iptables LOG` (or a userspace forwarder) appends non-DNS forwarded
  connections (src, dst, port, bytes).
- Both write to a **host-visible bind mount**, planned per run like the
  worktree mount. Log path and blacklist path come from the spawn plan / store.

### Network topology

- Egress container joins the run's private network when sidecars require it and
  the WAN face (default bridge). When the local stack is present, OmniRoute,
  Redis, llama.cpp, and bootstrap share the stack egress network namespace, so
  the agent reaches OmniRoute through `localhost` without an edge network.
- The agent joins **no** networks of its own; its only route out is the shared
  netns.
- Sidecar MCP servers keep the ADR-0005 pattern (run network + bridge WAN
  face).

## Verify first (the seam's sharp edges)

1. **DNS inheritance.** `--network container:` forbids `--dns`; confirm the
   agent's `resolv.conf` resolves through the egress container's dnsmasq
   (embed a probe: from the agent namespace, `getent hosts blacklisted.example`
   → sinkhole IP; `getent hosts allowed.example` → real IP). If inheritance
   does not hold, route agent DNS via the egress netns rules instead and
   document.
2. **Embedded DNS in a shared netns.** The embedded resolver (`127.0.0.11`)
   behaviour when two containers share one netns; sidecar name resolution must
   still work for the agent (via the egress container's run-network membership
   and its embedded-DNS rules).
3. **Engine parity.** `--network container:` on docker and podman CLIs; Docker
   Desktop (Linux containers) OK, Windows containers unsupported - document the
   floor.
4. **Egress container liveness.** Agent's netns disappears if the egress
   container dies mid-run; detect and warn like a crashed sidecar (already
   warned), never silently.

## Tasks

- [ ] Egress container image: Alpine + `dnsmasq` + `iptables` + logger shim;
      mounted blacklist file + mounted log file; default sinkhole `0.0.0.0`;
      optional stub HTTP 404.
- [ ] Replace `src/egress` whitelist derivation with blacklist planning:
      blacklist source (store file, e.g. `.e/egress-blacklist`, and/or CLI
      flag - decide); drop `deriveEgressAllowList`/`planEgressProxies`/socat
      Dockerfile.
- [ ] Runtime (`src/runtime`): start single egress container first; agent run
      args use `--network container:<run>-egress`; remove the per-host proxy
      and `--internal` code paths for the agent (sidecars unchanged).
- [ ] Spawn plan (`src/spawn`): plan the log + blacklist mounts; drop
      `ALLOWED_DOMAINS` forcing.
- [ ] Tests: plan + runtime + egress symmetry; blacklisted domain blocked and
      logged; allowed domain resolves; log file written host-side; engine-flag
      argv assertions.
- [ ] Docs: rewrite `docs/security/attack-surface.md` Zone 1 item 4; amend
      ADR-0011 or supersede with a new ADR (netns-shared egress monitor);
      record the rejections below.

## Considered and rejected

- **Per-host whitelist proxies (status quo).** Enumerated hosts only; breaks on
  unexpected destinations; the `ALLOWED_DOMAINS` hack proves the pain; no
  traffic observability.
- **CONNECT forward proxy (tinyproxy/squid) + `HTTP_PROXY`.** Harnesses do not
  honor proxy env vars (ADR-0011 measured Node/undici, Rust/reqwest, pi);
  traffic bypasses the proxy → monitor blind, blacklist moot.
- **Network policy layer (compose driver, CNI).** Violates the thin runtime
  seam (ADR-0005); heavier than the gap warrants.
- **Transparent gateway without netns sharing.** Requires pointing the agent's
  default route at a container and host iptables - not expressible through the
  thin CLI seam. Netns sharing (`--network container:`) is what makes the same
  effect expressible: the agent's interfaces _are_ the egress container's.

## Acceptance criteria

- [ ] A blacklisted destination is unreachable from the agent and the attempt
      appears in the mounted log.
- [ ] Non-blacklisted egress works without enumeration (provider, MCP, package
      registries, arbitrary hosts).
- [ ] Every DNS query and forwarded connection is recorded in the mounted log.
- [ ] Sidecar MCP servers resolve and are reachable from the agent; the local
      compose stack works through `localhost`.
- [ ] No new privileges on the agent container; egress container is trusted.

## References

- ADR-0002 (host orchestrates git; accepted egress + whole-file env injection)
- ADR-0005 (container groups, sidecars, private networks, thin runtime seam)
- ADR-0011 (whitelist proxies - superseded by this ticket)
- `docs/security/attack-surface.md`, Zone 1, item 4
- `src/egress/index.ts`, `src/spawn/spawnPlan.ts` (`ALLOWED_DOMAINS`),
  `src/runtime/index.ts`, `src/runs/runSpawn.ts`
