/**
 * dnsmasq query log parser (ADR-0012). dnsmasq runs with `--log-queries` and
 * `--log-facility=<file>`, which writes syslog-style lines without a hostname
 * field and without a year:
 *
 *     Sep  7 15:00:00 dnsmasq[1]: query[A] example.com from 127.0.0.1
 *     Sep 11 16:15:23 dnsmasq[1]: reply example.com is 93.184.216.34
 */

import { isSinkholed } from './blacklist.js';
import type { EgressLogEntry } from './types.js';

const TIMESTAMP = String.raw`(\w{3})\s+(\d+)\s+(\d{2}:\d{2}:\d{2})`;
const PREFIX = String.raw`^${TIMESTAMP}\s+dnsmasq\[\d+\]:\s+`;

/** `query[TYPE] domain from IP`; capture 4 is the domain. */
export const QUERY_RE = new RegExp(
  PREFIX + String.raw`query\[[^\]]+\]\s+(\S+)\s+from\s+`
);
/** `reply domain is IP`; capture 4 is the domain. */
export const REPLY_RE = new RegExp(PREFIX + String.raw`reply\s+(\S+)\s+is\s+`);

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
 * is `now`'s: dnsmasq never logs one.
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
  return new Date(
    Date.UTC(
      now.getFullYear(),
      monthIndex,
      parseInt(day, 10),
      hour,
      minute,
      second
    )
  ).toISOString();
}

/**
 * Parses one log line into an entry, or `null` for anything that is not a
 * query or reply line. `blacklistDomains` decides `allow` vs `deny(sinkholed)`.
 */
export function parseLogLine(
  line: string,
  blacklistDomains: readonly string[] = [],
  now: Date = new Date()
): EgressLogEntry | null {
  const match = QUERY_RE.exec(line) ?? REPLY_RE.exec(line);
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
