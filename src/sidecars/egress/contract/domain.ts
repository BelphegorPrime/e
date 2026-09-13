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

/**
 * True when `domain` is a well-formed DNS name.
 *
 * The ASCII guard comes first, before any normalization, because lowercasing
 * can turn a name the user did not type into one that passes: U+212A KELVIN
 * SIGN lowercases to `k`, so `\u212Aelvin.example` would otherwise be "valid"
 * and the config would end up blocking `kelvin.example`. Two entries that look
 * different in the blacklist would collapse to the same rule. A name is either
 * already ASCII or it is refused - callers that want an internationalized
 * domain must punycode it themselves, which is what reaches a resolver anyway.
 */
export function isValidDomain(domain: string): boolean {
  // Printable ASCII only: this also refuses the control characters - a newline
  // above all - that would end the directive early and inject a config line.
  if (/[^\x20-\x7e]/.test(domain)) return false;
  return DNS_NAME_RE.test(normalizeDomain(domain));
}

/** Lowercases a hostname and drops a trailing dot: `Example.COM.` -> `example.com`. */
export function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/\.$/, '');
}

/**
 * True when `domain` equals `parent` or is a subdomain of it, matching the
 * semantics of dnsmasq's `address=/parent/…` directive. Both sides are
 * normalized: every caller happens to pass an already-normalized parent
 * today, so normalizing only the child was invisible at the call site and
 * would have surprised the next one.
 */
export function isDomainOrSubdomain(domain: string, parent: string): boolean {
  const norm = normalizeDomain(domain);
  const parentNorm = normalizeDomain(parent);
  return norm === parentNorm || norm.endsWith('.' + parentNorm);
}

/** True when a domain resolves inside the stack (localhost and friends). */
export function isLocalhost(domain: string): boolean {
  return EGRESS_LOCAL_NAMES.some(local => isDomainOrSubdomain(domain, local));
}
