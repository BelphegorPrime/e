import { EGRESS_LOCAL_NAMES } from './constants.js';

/** Lowercases a hostname and drops a trailing dot: `Example.COM.` -> `example.com`. */
export function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/\.$/, '');
}

/**
 * True when `domain` equals `parent` or is a subdomain of it, matching the
 * semantics of dnsmasq's `address=/parent/…` directive.
 */
export function isDomainOrSubdomain(domain: string, parent: string): boolean {
  const norm = normalizeDomain(domain);
  return norm === parent || norm.endsWith('.' + parent);
}

/** True when a domain resolves inside the stack (localhost and friends). */
export function isLocalhost(domain: string): boolean {
  return EGRESS_LOCAL_NAMES.some(local => isDomainOrSubdomain(domain, local));
}
