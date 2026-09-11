/**
 * dnsmasq query log parser (ADR-0012). dnsmasq runs with `--log-queries` and
 * `--log-facility=<file>`, which writes syslog-style lines without a hostname
 * field and without a year:
 *
 *     Sep  7 15:00:00 dnsmasq[1]: query[A] example.com from 127.0.0.1
 *     Sep 11 16:15:23 dnsmasq[1]: reply example.com is 93.184.216.34
 *
 * Only `query` lines become entries. One lookup produces an A and an AAAA
 * query plus one `reply` line per CNAME hop and address, so counting replies
 * would inflate a domain several-fold and surface CNAME targets as if the
 * agent had asked for them.
 */

import { isSinkholed } from './blacklist.js';
import type { EgressLogEntry } from './types.js';

const TIMESTAMP = String.raw`(\w{3})\s+(\d+)\s+(\d{2}:\d{2}:\d{2})`;
const PREFIX = String.raw`^${TIMESTAMP}\s+dnsmasq\[\d+\]:\s+`;

/** `query[TYPE] domain from IP`; capture 4 is the domain. */
export const QUERY_RE = new RegExp(
  PREFIX + String.raw`query\[[^\]]+\]\s+(\S+)\s+from\s+`
);

const MONTHS: Readonly<Record<string, number>> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

/**
 * Converts the year-less syslog timestamp parts to ISO-8601 (UTC). The year
 * is `now`'s: dnsmasq never logs one. A result more than a day in the future
 * can only be last year's line read after New Year and is moved back a year.
 */
export function toISO8601(
  month: string,
  day: string,
  time: string,
  now: Date = new Date()
): string | null {
  const monthIndex = MONTHS[month];
  if (monthIndex === undefined) return null;
  const [hour, minute, second] = time.split(':').map(Number);
  const date = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      monthIndex,
      parseInt(day, 10),
      hour,
      minute,
      second
    )
  );
  if (date.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
    date.setUTCFullYear(date.getUTCFullYear() - 1);
  }
  return date.toISOString();
}

/**
 * Parses one query line into an entry, or `null` for any other line.
 * `blacklistDomains` is the blacklist as it is now, so `action` reflects the
 * current policy, not the one in force when the query was made.
 */
export function parseLogLine(
  line: string,
  blacklistDomains: readonly string[] = [],
  now: Date = new Date()
): EgressLogEntry | null {
  const match = QUERY_RE.exec(line);
  if (!match) return null;
  const [, month, day, time, domain] = match;
  return {
    timestamp: toISO8601(month, day, time, now) ?? '',
    runID: '',
    domain,
    protocol: 'DNS',
    action: isSinkholed(domain, blacklistDomains) ? 'deny(sinkholed)' : 'allow',
  };
}

/** Parses a whole log file; non-matching lines are skipped. */
export function parseDnsmasqLog(
  raw: string,
  blacklistDomains: readonly string[] = [],
  now: Date = new Date()
): EgressLogEntry[] {
  const entries: EgressLogEntry[] = [];
  for (const line of raw.split('\n')) {
    const entry = parseLogLine(line, blacklistDomains, now);
    if (entry) entries.push(entry);
  }
  return entries;
}
