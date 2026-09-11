/**
 * **Global egress** (ADR-0011) is composed once per local stack. Agent and MCP
 * containers share its network namespace (`--network container:e-egress`).
 * This module renders the host-editable blacklist consumed by that service.
 */

/** The image tag the shared egress container is built from (ADR-0011). */
export const EGRESS_IMAGE = 'e-egress';

/** Default Pi-hole style sinkhole: blacklisted names resolve here and fail fast. */
export const EGRESS_SINKHOLE = '0.0.0.0';

/**
 * Container-side paths for the egress mount files. The egress Dockerfile and
 * entrypoint (see `src/init/renderEgress.ts`) read these fixed paths; the host
 * path of each mount comes from the spawn plan / scratch.
 */
export const EGRESS_BLACKLIST_MOUNT = '/etc/egress.d/dnsmasq.blacklist';
export const EGRESS_LOG_MOUNT = '/var/log/egress';
// Named `.rules` (not `.blacklist`) so dnsmasq's `conf-dir=*.blacklist` glob
// never tries to parse the iptables script as a dnsmasq config file.
export const EGRESS_BLACKLIST_IP_MOUNT = '/etc/egress.d/iptables.rules';

/** The dnsmasq log file, written inside the mounted log dir. */
export const EGRESS_DNSMASQ_LOG = `${EGRESS_LOG_MOUNT}/dnsmasq.log`;

/** The port the egress HTTP API listens on inside the container (ADR-0012). */
export const EGRESS_API_PORT = 20129;

/** Default port for the egress API as published on the host (ADR-0012). */
export const EGRESS_API_HOST_PORT = 20129;

// Re-export structured types and helpers from submodules.
export type { EgressLogEntry, SquashedEntry, LogQuery } from './logParser.js';
export { appendBlacklistDomain, removeBlacklistDomain } from './blacklist.js';

/** A normalized blacklisted destination set, split by enforcement mechanism. */
export interface EgressBlacklist {
  /** Domains to sinkhole (matched with subdomains by dnsmasq's `address=/d/` form). */
  domains: string[];
  /** `ip:port` pairs to REJECT on the forwarded/output path (direct-IP bypass of DNS). */
  ipPorts: string[];
}

/**
 * The global egress container a local Compose stack owns. Agent and MCP
 * containers use `--network container:e-egress`; this spec is retained only for
 * compatibility with the runtime renderer.
 */
export interface EgressSpec {
  /** Unique per-run container name, e.g. `<runName>-egress`. */
  name: string;
  /** The built egress image tag (always {@link EGRESS_IMAGE}). */
  image: string;
  /** Host path of the rendered dnsmasq blacklist file, mounted read-write. */
  blacklistHost: string;
  /** Host path of the rendered iptables blacklist script, mounted read-only. */
  iptablesHost?: string;
  /** Host path of the log directory, mounted read-write and host-visible. */
  logHost: string;
  /** Private networks to attach (`--network`, repeatable); empty joins the default bridge. */
  networks: string[];
}

/**
 * Parses the blacklist source (the store's `.e/egress-blacklist`) into its
 * domain and IP:port halves, purely. Lines starting with `#` or `;` are comments;
 * blank lines are ignored. A line containing `:` with a numeric suffix is treated
 * as an `ip:port` pair (IPv4 today; v6 addresses are not expressible in this
 * format), anything else is a domain. Domains are normalized to lowercase with no
 * surrounding whitespace. Unparseable lines are skipped, not fatal — a malformed
 * line must never abort a spawn's egress setup.
 */
export function parseBlacklist(content: string): EgressBlacklist {
  const domains: string[] = [];
  const ipPorts: string[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (isIpPort(line)) {
      ipPorts.push(line);
    } else {
      domains.push(line.toLowerCase().replace(/^\.+|\.+$/g, ''));
    }
  }
  return { domains, ipPorts };
}

/** True when `s` looks like an `ip:port` pair (IPv4 with a numeric port). */
function isIpPort(s: string): boolean {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(s);
  if (!m) return false;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535;
}

/**
 * Renders the dnsmasq address lines for a set of blacklisted domains. Each
 * `address=/domain/sinkhole` bounces the domain *and every subdomain* to the
 * sinkhole IP (Pi-hole semantics), so `example.com` blocks `example.com`,
 * `api.example.com`, `a.b.example.com`. The bounce also guarantees dnsmasq
 * logs the query. Returns an empty string when there is nothing to block.
 */
export function renderDnsmasqConf(
  domains: string[],
  sinkhole: string = EGRESS_SINKHOLE
): string {
  return domains.map(domain => `address=/${domain}/${sinkhole}`).join('\n');
}

/**
 * Renders the iptables REJECT rules for a set of blacklisted `ip:port` pairs,
 * as a `sh` script applied by the egress entrypoint into a dedicated `EGRESS`
 * chain (hooked once into `OUTPUT`; the entrypoint flushes and re-applies the
 * chain on SIGHUP). REJECTing on the egress netns's OUTPUT path catches
 * direct-IP connections that bypass DNS; `--reject-with icmp-port-unreachable`
 * makes the connection fail fast and visibly, distinct from a silent drop.
 * Returns an empty string when there is nothing to block.
 */
export function renderIptablesRules(ipPorts: string[]): string {
  return ipPorts
    .map((entry, idx) => {
      const [host, port] = entry.split(':');
      return `iptables -A EGRESS -d ${host} -p tcp --dport ${port} -j REJECT --reject-with icmp-port-unreachable # rule ${idx + 1}`;
    })
    .join('\n');
}
