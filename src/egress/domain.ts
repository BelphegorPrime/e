import { EGRESS_LOCAL_NAMES } from './constants.js';

/**
 * A syntactically valid DNS name after {@link normalizeDomain}: dot-separated
 * LDH labels (letters, digits, hyphen; no leading/trailing hyphen), at most
 * 253 characters. This is what may be written into a dnsmasq `address=`
 * directive; anything else (slashes, whitespace, `#`, newlines) would inject
 * or corrupt dnsmasq config and take the shared resolver down.
 */
const DNS_NAME_RE =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** True when `domain` is a well-formed DNS name (checked after normalization). */
export function isValidDomain(domain: string): boolean {
  return DNS_NAME_RE.test(normalizeDomain(domain));
}

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
