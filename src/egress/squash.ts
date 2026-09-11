import { EgressLogEntry, SquashedEntry } from './logParser.js';

/** Names always resolving inside the stack — noise, not egress signal. */
const LOCAL_NAMES = new Set(['localhost', 'localhost.localdomain']);

/** True when a domain resolves inside the stack (localhost, etc.). */
function isLocalhost(domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/\.$/, '');
  for (const local of LOCAL_NAMES) {
    if (normalized === local || normalized.endsWith('.' + local)) return true;
  }
  return false;
}

/**
 * Squash same-domain entries into rollups.
 * Every domain yields exactly one record, counting all of its entries;
 * records keep the order of first appearance. Localhost entries are dropped.
 */
export function squashEntries(entries: EgressLogEntry[]): SquashedEntry[] {
  const byDomain = new Map<string, SquashedEntry>();

  for (const entry of entries) {
    if (isLocalhost(entry.domain)) {
      continue;
    }

    const existing = byDomain.get(entry.domain);
    if (existing) {
      existing.count++;
    } else {
      byDomain.set(entry.domain, { domain: entry.domain, count: 1 });
    }
  }

  const entriesInOrder = Array.from(byDomain.values()).sort(
    // start with the highest count first
    (a, b) => b.count - a.count
  );
  return entriesInOrder;
}
