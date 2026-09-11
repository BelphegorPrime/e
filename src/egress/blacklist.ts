/**
 * The host-mounted dnsmasq blacklist file (ADR-0012). It is read directly by
 * dnsmasq's `--conf-dir`, so every non-comment line must be a valid dnsmasq
 * directive: `address=/domain/0.0.0.0` sinkholes a domain and its subdomains.
 * A bare domain line is invalid dnsmasq syntax and crashes dnsmasq on start;
 * this module never writes one but still tolerates one when reading, so a
 * hand-edited file can at least be listed and classified. `ip:port` lines are
 * skipped: direct-IP blocking lives in the iptables rules script
 * (`.e/egress-iptables.rules`), not in dnsmasq config.
 */

import { normalizeDomain, isDomainOrSubdomain } from './domain.js';

const ADDRESS_DIRECTIVE_RE = /^address=\/([^/]+)\//;

/** True when a line is an IPv4 `ip:port` pair (a legacy iptables-style entry). */
function isIpPort(line: string): boolean {
  const idx = line.lastIndexOf(':');
  if (idx < 0) return false;
  const ipPart = line.slice(0, idx);
  const portPart = line.slice(idx + 1);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ipPart) || !/^\d+$/.test(portPart)) {
    return false;
  }
  const port = parseInt(portPart, 10);
  return port > 0 && port <= 65535;
}

/**
 * The domain a blacklist line targets, or `null` for comments, blank lines and
 * `ip:port` entries. An `address=` directive yields its embedded domain; any
 * other line is treated as a bare domain.
 */
export function blacklistLineDomain(rawLine: string): string | null {
  const line = rawLine.trim();
  if (!line || line.startsWith('#') || line.startsWith(';')) return null;
  const match = ADDRESS_DIRECTIVE_RE.exec(line);
  if (match) return normalizeDomain(match[1]);
  if (isIpPort(line)) return null;
  return normalizeDomain(line);
}

/**
 * The distinct blacklisted domains of a blacklist file, in first-seen order.
 * A domain contributes one `address=` line per address family, so the list
 * is deduplicated.
 */
export function parseBlacklistDomains(content: string): string[] {
  const domains: string[] = [];
  for (const raw of content.split('\n')) {
    const domain = blacklistLineDomain(raw);
    if (domain !== null) domains.push(domain);
  }
  return [...new Set(domains)];
}

/** True when `domain` (or a parent of it) is on the blacklist. */
export function isSinkholed(
  domain: string,
  blacklistDomains: readonly string[]
): boolean {
  return blacklistDomains.some(b => isDomainOrSubdomain(domain, b));
}

/**
 * Appends the sinkhole directives for `domain` to the file content, or returns
 * the content unchanged when the domain is already listed. Both address
 * families are written: an `address=` line only sinkholes the record type its
 * target belongs to, so an IPv4-only entry leaves the domain reachable over
 * AAAA/IPv6.
 */
export function appendBlacklistDomain(content: string, domain: string): string {
  const norm = normalizeDomain(domain);
  if (parseBlacklistDomains(content).includes(norm)) return content;
  const head = content ? content.trimEnd() + '\n' : '';
  return `${head}address=/${norm}/0.0.0.0\naddress=/${norm}/::\n`;
}

/**
 * Removes every line (any address family) that targets `domain`. The result
 * is normalized to end in exactly one newline, or to be empty when nothing is
 * left, so repeated add/remove cycles never accumulate blank lines.
 */
export function removeBlacklistDomain(content: string, domain: string): string {
  const norm = normalizeDomain(domain);
  const kept = content.split('\n').filter(line => {
    const t = line.trim();
    const match = ADDRESS_DIRECTIVE_RE.exec(t);
    const lineDomain = normalizeDomain(match ? match[1] : t);
    return lineDomain !== norm;
  });
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  return kept.length === 0 ? '' : kept.join('\n') + '\n';
}
