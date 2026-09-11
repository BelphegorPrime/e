/**
 * DNS query log parser (ADR-0012). Turns raw dnsmasq log lines into
 * structured entries the egress API serves. Dnsmasq runs with
 * `--log-queries` (no `--log-time`), so timestamps are syslog-style
 * `MMM  D HH:MM:SS` without a year; we use the current year.
 */

/** A structured egress log entry (ADR-0012 schema). */
export interface EgressLogEntry {
  /** ISO-8601 timestamp of the query. */
  timestamp: string;
  /** Branch-based run identifier (not derivable from dnsmasq log; empty for now). */
  runID: string;
  /** Queried hostname. */
  domain: string;
  /** Protocol — always DNS for dnsmasq. */
  protocol: 'DNS';
  /** `allow` when domain is not blacklisted, `deny(sinkholed)` when it is. */
  action: 'allow' | 'deny(sinkholed)';
}

/** Squashed rollup of consecutive same-domain entries (ADR-0012). */
export interface SquashedEntry {
  domain: string;
  count: number;
}

/** Query filters for `GET /logs`. */
export interface LogQuery {
  since?: string;
  domain?: string;
  action?: 'allow' | 'deny(sinkholed)';
  limit?: number;
}

/** Matches a dnsmasq query line: `query[TYPE] domain from IP`. */
const QUERY_RE =
  /^\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\S+\s+dnsmasq\[\d+\]:\s+query\[[^\]]+\]\s+(\S+)\s+from\s+/;

/** Matches a dnsmasq reply line: `reply domain is IP`. */
const REPLY_RE =
  /^\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\S+\s+dnsmasq\[\d+\]:\s+reply\s+(\S+)\s+is\s+/;

const MONTH_MAP: Record<string, number> = {
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

/** Cached year for timestamp conversion. */
let cachedYear = 0;
let cachedMonth = -1;

function yearFor(monthIndex: number): number {
  if (cachedYear !== 0 && cachedMonth === monthIndex) return cachedYear;
  const now = new Date();
  cachedYear = now.getFullYear();
  cachedMonth = now.getMonth();
  return cachedYear;
}

/** Converts a dnsmasq syslog timestamp `Jul  9 14:32:01` to ISO-8601. */
export function toISO8601(timestamp: string): string {
  const match = /^(\w{3})\s+(\d+)\s+(\d{2}:\d{2}:\d{2})$/.exec(
    timestamp.trim()
  );
  if (!match) return timestamp;
  const month = MONTH_MAP[match[1]];
  if (month === undefined) return timestamp;
  const day = parseInt(match[2], 10);
  const [hour, minute, second] = match[3].split(':').map(Number);
  const year = yearFor(month);
  return new Date(
    Date.UTC(year, month, day, hour, minute, second)
  ).toISOString();
}

/** Extracts the timestamp portion from the start of a dnsmasq line. */
export function extractTimestamp(line: string): string {
  const match = /^(\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2})/.exec(line);
  return match ? match[1] : '';
}

/**
 * Parse a single dnsmasq log line into a structured entry, or null when the
 * line is not a query/reply. `blacklistDomains` is checked to determine allow
 * vs deny(sinkholed) — pass a Set of normalized (lowercase, no trailing dot)
 * blacklisted domains for blacklist-aware action assignment.
 */
export function parseLogLine(
  line: string,
  blacklistDomains: Set<string> = new Set()
): EgressLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const queryMatch = QUERY_RE.exec(trimmed);
  const replyMatch = REPLY_RE.exec(trimmed);

  let domain: string | null = null;
  if (queryMatch) domain = queryMatch[1];
  else if (replyMatch) domain = replyMatch[1];
  if (!domain) return null;

  const timestamp = toISO8601(extractTimestamp(trimmed));
  const normalized = domain.toLowerCase().replace(/\.$/, '');
  const isSinkholed =
    blacklistDomains.has(normalized) ||
    [...blacklistDomains].some(
      b => normalized === b || normalized.endsWith('.' + b)
    );
  const action = isSinkholed ? 'deny(sinkholed)' : 'allow';

  return {
    timestamp,
    runID: '',
    domain,
    protocol: 'DNS',
    action,
  };
}

/**
 * Parse raw dnsmasq log content into structured entries, using the blacklist
 * domain set to classify each entry as allow or deny(sinkholed).
 */
export function parseDnsmasqLog(
  raw: string,
  blacklistDomains: Set<string> = new Set()
): EgressLogEntry[] {
  const lines = raw.split('\n');
  const entries: EgressLogEntry[] = [];
  for (const line of lines) {
    const entry = parseLogLine(line, blacklistDomains);
    if (entry) entries.push(entry);
  }
  return entries;
}
