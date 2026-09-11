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

/**
 * Applies the `GET /logs` filters (ADR-0012: since / domain / action / limit).
 * An unparsable `since` is ignored here (the API rejects it with 400 first);
 * `limit` keeps the newest entries and only counts when it is a positive
 * integer (`0`, negatives and garbage mean "no limit"); `domain` matches
 * case-insensitively and ignores a trailing dot, like the squash view.
 */
export function applyLogQuery(
  entries: readonly EgressLogEntry[],
  query: LogQuery
): EgressLogEntry[] {
  let result = [...entries];
  if (query.since) {
    const since = Date.parse(query.since);
    if (!Number.isNaN(since)) {
      result = result.filter(e => Date.parse(e.timestamp) >= since);
    }
  }
  if (query.domain) {
    const wanted = normalizeDomain(query.domain);
    result = result.filter(e => normalizeDomain(e.domain) === wanted);
  }
  if (query.action) result = result.filter(e => e.action === query.action);
  if (query.limit) {
    const limit = Number(query.limit);
    if (Number.isInteger(limit) && limit > 0) result = result.slice(-limit);
  }
  return result;
}
