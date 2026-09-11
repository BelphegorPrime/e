/**
 * Blacklist file helpers (ADR-0012). Thin write/read layer over the
 * host-mounted `dnsmasq.blacklist` file — one source of truth stays on disk.
 */

import {
  EGRESS_BLACKLIST_MOUNT,
  EgressBlacklist,
  parseBlacklist,
} from './index.js';

/** Reads the host-mounted dnsmasq blacklist file (empty string when absent). */
export function readBlacklistFile(): string {
  try {
    return require('node:fs').readFileSync(EGRESS_BLACKLIST_MOUNT, 'utf-8');
  } catch {
    return '';
  }
}

/** Appends a domain to the blacklist content (one per line, lowercase). */
export function appendBlacklistDomain(content: string, domain: string): string {
  const lines = content
    .trim()
    .split('\n')
    .filter(l => {
      const t = l.trim();
      return t && !t.startsWith('#') && !t.startsWith(';');
    });
  const normalized = domain.toLowerCase().replace(/\.$/, '');
  if (lines.includes(normalized)) return content;
  return (content ? content.trimEnd() + '\n' : '') + normalized + '\n';
}

/** Removes a domain from the blacklist content. */
export function removeBlacklistDomain(content: string, domain: string): string {
  const normalized = domain.toLowerCase().replace(/\.$/, '');
  return (
    content
      .split('\n')
      .filter(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';'))
          return true;
        return trimmed.toLowerCase() !== normalized;
      })
      .join('\n') + '\n'
  );
}

/** Parse the blacklist file content into structured form. */
export function parseBlacklistFile(content: string): EgressBlacklist {
  return parseBlacklist(content);
}
