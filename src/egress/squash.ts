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
 * Squash consecutive same-domain entries into rollups.
 * Entries are processed in log order; a run of identical domains
 * collapses to one record. Localhost entries are dropped.
 */
export function squashEntries(entries: EgressLogEntry[]): SquashedEntry[] {
  const result: SquashedEntry[] = [];
  let current: SquashedEntry | undefined;

  for (const entry of entries) {
    if (isLocalhost(entry.domain)) continue;

    if (current && current.domain === entry.domain) {
      current.count++;
      current.lastSeen = entry.timestamp;
    } else {
      current = {
        domain: entry.domain,
        count: 1,
        firstSeen: entry.timestamp,
        lastSeen: entry.timestamp,
      };
      result.push(current);
    }
  }
  return result;
}
