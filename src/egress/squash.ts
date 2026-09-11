import { isLocalhost, normalizeDomain } from './domain.js';
import type { EgressLogEntry, LogQuery, SquashedEntry } from './types.js';

/**
 * One record per domain over the whole log, NOT per consecutive run (which
 * yields thousands of rows for a handful of domains). Keyed on the normalized
 * name so `Example.com.` and `example.com` roll up together; localhost noise
 * is dropped. Sorted by count, highest first.
 */
export function squashEntries(
  entries: readonly EgressLogEntry[]
): SquashedEntry[] {
  const byDomain = new Map<string, SquashedEntry>();
  for (const entry of entries) {
    if (isLocalhost(entry.domain)) continue;
    const domain = normalizeDomain(entry.domain);
    const existing = byDomain.get(domain);
    if (existing) {
      existing.count++;
      if (entry.timestamp < existing.firstSeen) {
        existing.firstSeen = entry.timestamp;
      }
      if (entry.timestamp > existing.lastSeen) {
        existing.lastSeen = entry.timestamp;
      }
    } else {
      byDomain.set(domain, {
        domain,
        count: 1,
        firstSeen: entry.timestamp,
        lastSeen: entry.timestamp,
      });
    }
  }
  return [...byDomain.values()].sort((a, b) => b.count - a.count);
}

/** Applies the `GET /logs` filters (ADR-0012: since / domain / action / limit). */
export function applyLogQuery(
  entries: readonly EgressLogEntry[],
  query: LogQuery
): EgressLogEntry[] {
  let result = [...entries];
  if (query.since) {
    const since = new Date(query.since).getTime();
    result = result.filter(e => new Date(e.timestamp).getTime() >= since);
  }
  if (query.domain) result = result.filter(e => e.domain === query.domain);
  if (query.action) result = result.filter(e => e.action === query.action);
  if (query.limit) result = result.slice(-Number(query.limit));
  return result;
}
