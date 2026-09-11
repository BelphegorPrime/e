/**
 * Renders the **egress gateway** build context (ADR-0011): a Dockerfile,
 * an entrypoint script, a dnsmasq config, a blacklist template, and the
 * bundled Node.js egress API server (ADR-0012), all seeded into `.e/egress/`
 * mirroring how harness/mcp build contexts are seeded (never clobbered, so a
 * user can edit them). The rendered image `e-egress` is built once and started
 * once as a global stack service; every stack service and run agent joins the
 * egress netns and routes all outbound through it.
 *
 * The rendered artifacts:
 *
 *  - `Dockerfile`: Alpine + `nodejs` + `dnsmasq` + `iptables`. Non-root is NOT
 *    applied here by design: the egress container is ours (trusted), and
 *    iptables needs `NET_ADMIN` in its own netns (added at run time, never on
 *    the agent).
 *  - `entrypoint.sh`: applies the mounted iptables blacklist to its own netns,
 *    starts the egress API server (ADR-0012) in the background, re-applies
 *    iptables + restarts dnsmasq on SIGHUP, then supervises `dnsmasq` with
 *    query logging to the mounted log dir and its blacklist conf-dir read
 *    from the mounted blacklist file.
 *  - `dnsmasq.conf`: the base dnsmasq config with independent upstream
 *    resolvers.
 *  - `egress-api.mjs`: the egress HTTP API server (ADR-0012). Not a template:
 *    it is the type-checked `src/egress/server.ts` and its imports, bundled by
 *    `scripts/build-egress-api.mjs` into one dependency-free ESM script.
 *  - `blacklist.example`: a commented template documenting the format.
 *  - `iptables.example`: a commented template for the direct-IP rules script
 *    the entrypoint applies into its EGRESS chain.
 *
 * None of these files carry per-installation variables, so they are plain
 * template literals over the shared egress constants rather than Mustache
 * templates (Mustache would also eat a literal `{{` in a shell or config file).
 */

import { EGRESS_API_BUNDLE } from '../egress/bundle.generated.js';
import {
  EGRESS_BLACKLIST_IP_MOUNT,
  EGRESS_DNSMASQ_LOG,
  EGRESS_LOG_MOUNT,
} from '../egress/constants.js';

/** File names inside the egress build context, keyed for `renderEgressFiles`. */
export const EGRESS_FILES = {
  dockerfile: 'Dockerfile',
  entrypoint: 'entrypoint.sh',
  dnsmasqConf: 'dnsmasq.conf',
  apiScript: 'egress-api.mjs',
  blacklistExample: 'blacklist.example',
  iptablesExample: 'iptables.example',
} as const;

export type EgressFileName = (typeof EGRESS_FILES)[keyof typeof EGRESS_FILES];

const DOCKERFILE = `# The egress gateway container (ADR-0011). A single global service; all
# stack services and run agents share its network namespace, so a blacklist here
# is enforced and every query / connection is logged host-side.
FROM node:24-alpine

RUN apk add --no-cache dnsmasq iptables ip6tables bash

COPY ${EGRESS_FILES.entrypoint} /egress-entrypoint.sh
COPY ${EGRESS_FILES.dnsmasqConf} /etc/egress.d/dnsmasq.conf
COPY ${EGRESS_FILES.apiScript} /egress-api.mjs
RUN chmod +x /egress-entrypoint.sh

# Compose mounts the blacklist file and log directory explicitly. Do not declare
# /etc/egress.d as a VOLUME: Docker would preserve an anonymous volume across
# container recreation, masking rebuilt dnsmasq.conf files with stale content.

# iptables needs NET_ADMIN in this container's own netns (added by the runtime).
ENTRYPOINT ["/egress-entrypoint.sh"]
`;

const DNSMASQ_BASE_CONF = `# Base dnsmasq config for the egress gateway (ADR-0011).
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

const BLACKLIST_EXAMPLE = `# Egress blacklist for e runs (ADR-0011).
#
# Read directly by dnsmasq's --conf-dir, so every entry must be a valid dnsmasq
# directive: \`address=/domain/0.0.0.0\` sinkholes a domain and all its
# subdomains (resolves to 0.0.0.0 so the connection fails fast and is logged).
# A bare domain (no \`address=/.../\`) is invalid dnsmasq syntax and will crash
# the egress container's dnsmasq on startup. '#' and ';' start a comment; blank
# lines are ignored. This file is never clobbered by e init.
#
# Each address line only covers its own address family, so block both or the
# domain stays reachable over the other one:
#
# address=/example.com/0.0.0.0   # blocks example.com and *.example.com over IPv4
# address=/example.com/::        # ...and the same over IPv6
`;

const IPTABLES_EXAMPLE = `# Egress iptables rules for e runs (ADR-0011): direct-IP blocking.
#
# The DNS sinkhole (egress-blacklist) only catches connections that resolve a
# name first. This file is a plain sh script the egress entrypoint runs inside
# its own network namespace (on start and after every SIGHUP), so rules here
# block connections to hardcoded IPs. Append to the EGRESS chain only: the
# entrypoint flushes and re-applies that chain and never touches OUTPUT itself.
# This file is never clobbered by e init; reload with:
#   docker kill -s HUP e-egress
#
# iptables -A EGRESS -d 203.0.113.7 -p tcp --dport 443 -j REJECT --reject-with icmp-port-unreachable
# ip6tables -A EGRESS -d 2001:db8::7 -p tcp --dport 443 -j REJECT --reject-with icmp6-port-unreachable
`;

// Shell parameter expansions are written as \${VAR} so the TS template literal
// leaves them for the shell.
const ENTRYPOINT = `#!/bin/sh
# Egress gateway entrypoint (ADR-0011). Applies the mounted iptables blacklist
# to this netns, starts the egress HTTP API (ADR-0012) in the background, then
# supervises dnsmasq with query logging. All stack services and run agents
# share this container's network namespace, so every DNS query and connection
# crosses here and is logged / blocked.
#
# dnsmasq's own SIGHUP handling only refreshes hosts-style data (/etc/hosts,
# DHCP lease files); it never re-reads --conf-dir directives, which is exactly
# how the mounted blacklist's \`address=/domain/0.0.0.0\` lines are declared
# (dnsmasq(8)). So a blacklist add/remove needs a full dnsmasq restart to take
# effect, not a reload. This script therefore stays PID 1 itself (it never
# \`exec\`s into dnsmasq) and restarts the dnsmasq child on SIGHUP; the egress
# API (ADR-0012) triggers that by sending SIGHUP to PID 1 after every mutation.
set -eu

IP_BLACKLIST="${EGRESS_BLACKLIST_IP_MOUNT}"
DNSMASQ_CONF="/etc/egress.d/dnsmasq.conf"
DNSMASQ_PID=""

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

start_dnsmasq() {
  # -k keep running, -d don't daemonize (also lets this script capture its
  # pid -- daemonizing forks and never writes one). --conf-file reads the base
  # config (bind-interfaces + listen-address=127.0.0.1, so it never clashes
  # with the engine's embedded DNS at 127.0.0.11 in the same netns);
  # --conf-dir reads the mounted *.blacklist for sinkhole address lines.
  dnsmasq -k -d \\
    --conf-file="\${DNSMASQ_CONF}" \\
    --conf-dir=/etc/egress.d/,*.blacklist \\
    --log-queries \\
    --log-facility="${EGRESS_DNSMASQ_LOG}" &
  DNSMASQ_PID=$!
}

restart_dnsmasq() {
  apply_ip_rules
  if [ -n "\${DNSMASQ_PID}" ] && kill -0 "\${DNSMASQ_PID}" 2>/dev/null; then
    kill "\${DNSMASQ_PID}" 2>/dev/null || true
    while kill -0 "\${DNSMASQ_PID}" 2>/dev/null; do
      sleep 0.1
    done
  fi
  echo "egress: restarting dnsmasq to pick up blacklist changes" >&2
  start_dnsmasq
}

apply_ip_rules

# Start the egress HTTP API (ADR-0012) in the background.
node /egress-api.mjs &

trap 'restart_dnsmasq' HUP
trap 'kill "\${DNSMASQ_PID}" 2>/dev/null || true; exit 0' TERM INT

mkdir -p "${EGRESS_LOG_MOUNT}"
start_dnsmasq

# Supervise: exit (taking the container down, matching the old \`exec\`
# behavior) only if dnsmasq dies on its own. A HUP-triggered restart replaces
# \${DNSMASQ_PID} before this next checks it, so the loop just keeps watching
# whichever process is current.
while kill -0 "\${DNSMASQ_PID}" 2>/dev/null; do
  sleep 1
done
`;

/** Renders the `entrypoint.sh` for the egress container. */
export function renderEgressEntrypoint(): string {
  return ENTRYPOINT;
}

/**
 * The egress API server script (ADR-0012): the bundled, type-checked
 * `src/egress/server.ts`. Kept as a function so callers stay uniform with the
 * other renderers.
 */
export function renderEgressApiJs(): string {
  return EGRESS_API_BUNDLE;
}

/** Renders the base `dnsmasq.conf` for the egress container. */
export function renderDnsmasqBaseConf(): string {
  return DNSMASQ_BASE_CONF;
}

/** Renders the `Dockerfile` for the egress container. */
export function renderEgressDockerfile(): string {
  return DOCKERFILE;
}

/** Renders the user-facing blacklist template seeded as `blacklist.example`. */
export function renderBlacklistExample(): string {
  return BLACKLIST_EXAMPLE;
}

/** Renders the direct-IP rules template seeded as `iptables.example` and `.e/egress-iptables.rules`. */
export function renderIptablesExample(): string {
  return IPTABLES_EXAMPLE;
}

/** The files `e init` writes into `.e/egress/`, keyed by file name. */
export function renderEgressFiles(): Record<EgressFileName, string> {
  return {
    [EGRESS_FILES.dockerfile]: renderEgressDockerfile(),
    [EGRESS_FILES.entrypoint]: renderEgressEntrypoint(),
    [EGRESS_FILES.dnsmasqConf]: renderDnsmasqBaseConf(),
    [EGRESS_FILES.apiScript]: renderEgressApiJs(),
    [EGRESS_FILES.blacklistExample]: renderBlacklistExample(),
    [EGRESS_FILES.iptablesExample]: renderIptablesExample(),
  };
}
