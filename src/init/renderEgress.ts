/**
 * Renders the **egress gateway** build context (ADR-0011): a Dockerfile,
 * an entrypoint script, a dnsmasq config, and a blacklist template that `e init`
 * seeds into `.e/egress/` — mirroring how harness/mcp build contexts are seeded
 * (never clobbered, so a user can edit them). The rendered image `e-egress` is
 * built once and started once as a global stack service; every stack service and
 * every run agent joins the egress netns and routes all outbound through it.
 *
 * The three rendered artifacts:
 *
 *  - `Dockerfile` — Alpine + `dnsmasq` + `iptables`, non-root is NOT applied here
 *    by design: the egress container is ours (trusted), and iptables needs
 *    `NET_ADMIN` in its own netns (added at run time, never on the agent).
 *  - `entrypoint.sh` — applies the mounted iptables blacklist to its own netns,
 *    re-applies it on SIGHUP, then runs `dnsmasq` in the foreground with query
 *    logging to the mounted log dir and its blacklist conf-dir read from the
 *    mounted blacklist file.
 *  - `dnsmasq.conf` — the base dnsmasq config with independent upstream
 *    resolvers that `entrypoint.sh` points dnsmasq at.
 *  - `blacklist.example` — a commented template documenting the `./e/egress-blacklist`
 *    format, seeded as the user-facing example (not read by the container).
 */

import {
  EGRESS_BLACKLIST_IP_MOUNT,
  EGRESS_LOG_MOUNT,
} from '../egress/index.js';

/** Renders the `entrypoint.sh` for the egress container. */
export function renderEgressEntrypoint(): string {
  return `#!/bin/sh
# Egress gateway entrypoint (ADR-0011). Applies the mounted iptables blacklist
# to this netns, then runs dnsmasq in the foreground with query logging. All
# stack services and run agents share this container's network namespace,
# so every DNS query and connection crosses here and is logged / blocked.
set -eu

IP_BLACKLIST="${EGRESS_BLACKLIST_IP_MOUNT}"
DNSMASQ_CONF="/etc/egress.d/dnsmasq.conf"

apply_ip_rules() {
  # Hook a dedicated EGRESS chain into OUTPUT once, then (re)apply the mounted
  # rules. Using a chain (not \`iptables -F OUTPUT\`) never clobbers the engine's
  # own netns rules (e.g. the embedded-DNS path Docker wires in the same netns).
  iptables -N EGRESS 2>/dev/null || iptables -F EGRESS
  iptables -C OUTPUT -j EGRESS 2>/dev/null || iptables -I OUTPUT -j EGRESS
  if [ -f "\${IP_BLACKLIST}" ]; then
    sh "\${IP_BLACKLIST}" || true
  fi
  echo "egress: applied iptables blacklist \${IP_BLACKLIST}" >&2
}

apply_ip_rules

# Reload dnsmasq + re-apply iptables on SIGHUP so a host edit to the mounted
# blacklist takes effect without restarting the shared netns.
trap 'apply_ip_rules; kill -HUP $(cat /run/dnsmasq.pid 2>/dev/null) 2>/dev/null || true' HUP

mkdir -p "${EGRESS_LOG_MOUNT}"
# -k keep running, -d don't daemonize. --conf-file reads the base config
# (bind-interfaces + listen-address=127.0.0.1, so it never clashes with the
# engine's embedded DNS at 127.0.0.11 in the same netns); --conf-dir reads the
# mounted *.blacklist for sinkhole address lines.
exec dnsmasq -k -d \\
  --conf-file="\${DNSMASQ_CONF}" \\
  --conf-dir=/etc/egress.d/,*.blacklist \\
  --log-queries \\
  --log-facility="${EGRESS_LOG_MOUNT}/dnsmasq.log"
`;
}

/** Renders the base `dnsmasq.conf` for the egress container. */
export function renderDnsmasqBaseConf(): string {
  return `# Base dnsmasq config for the egress gateway (ADR-0011).
# The mounted blacklist (address=/domain/0.0.0.0 lines) is read from
# the conf-dir; log-queries records every query to the mounted log.
#
# Containers query the engine's embedded DNS first. It resolves container
# aliases itself and forwards public names to dnsmasq because compose configures
# 127.0.0.1 as its external resolver. dnsmasq must therefore use independent
# upstreams: forwarding back to the embedded resolver creates a DNS loop.
port=53
bind-interfaces
listen-address=127.0.0.1
no-resolv
no-poll
server=1.1.1.1
server=8.8.8.8
`;
}

/** Renders the `Dockerfile` for the egress container. */
export function renderEgressDockerfile(): string {
  return `# The egress gateway container (ADR-0011). A single global service; all stack
# services and run agents share its network namespace, so a blacklist here is
# enforced and every query / connection is logged host-side.
FROM alpine:3.20

RUN apk add --no-cache dnsmasq iptables ip6tables bash

COPY entrypoint.sh /egress-entrypoint.sh
COPY dnsmasq.conf /etc/egress.d/dnsmasq.conf
RUN chmod +x /egress-entrypoint.sh

# Compose mounts the blacklist file and log directory explicitly. Do not declare
# /etc/egress.d as a VOLUME: Docker would preserve an anonymous volume across
# container recreation, masking rebuilt dnsmasq.conf files with stale content.

# iptables needs NET_ADMIN in this container's own netns (added by the runtime).
ENTRYPOINT ["/egress-entrypoint.sh"]
`;
}

/** Renders the user-facing blacklist template seeded as `blacklist.example`. */
export function renderBlacklistExample(): string {
  return `# Egress blacklist for e runs (ADR-0011).
#
# One entry per line. A domain line is sinkholed by dnsmasq (blocks the domain
# and all its subdomains, resolves to 0.0.0.0 so the connection fails fast and
# is logged). An IPv4:port line is REJECTed by iptables (catches direct-IP
# connections that bypass DNS entirely). '#' and ';' start a comment; blank
# lines are ignored. This file is never clobbered by e init.
#
# example.com            # blocks example.com and *.example.com
# 203.0.113.7:8443       # rejects the direct IP:port
`;
}

/** The files `e init` writes into `.e/egress/`, keyed by file name. */
export function renderEgressFiles(): Record<string, string> {
  return {
    'Dockerfile': renderEgressDockerfile(),
    'entrypoint.sh': renderEgressEntrypoint(),
    'dnsmasq.conf': renderDnsmasqBaseConf(),
    'blacklist.example': renderBlacklistExample(),
  };
}
