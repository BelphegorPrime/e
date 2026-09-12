/** Wire types of the egress HTTP API (ADR-0012). */

/** `allow` when the queried name is not blacklisted, else `deny(sinkholed)`. */
export type EgressAction = 'allow' | 'deny(sinkholed)';

/** A structured egress log entry served by `GET /logs`. */
export interface EgressLogEntry {
  /** ISO-8601 timestamp of the query. */
  timestamp: string;
  /** Branch-based run identifier (not derivable from the dnsmasq log; empty for now). */
  runID: string;
  /** Queried hostname, as logged by dnsmasq. */
  domain: string;
  /** Protocol: always DNS for dnsmasq. */
  protocol: 'DNS';
  /** Classified against the blacklist at read time (the API is stateless). */
  action: EgressAction;
}

/** One rollup per domain served by `GET /logs/squashed`. */
export interface SquashedEntry {
  /** Normalized (lowercase, no trailing dot) domain. */
  domain: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

/** Query-string filters accepted by `GET /logs`. */
export interface LogQuery {
  since?: string;
  domain?: string;
  action?: string;
  limit?: string;
}

/** Body of `POST /blacklist/domains`. */
export interface BlacklistAddRequest {
  domain: string;
}

/** Body of `GET /blacklist/domains`. */
export interface BlacklistDomainsResponse {
  domains: string[];
}

export interface StatusResponse {
  status: 'ok';
}

export interface ErrorResponse {
  error: string;
}
