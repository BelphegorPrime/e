/**
 * The egress HTTP API (ADR-0012), as a plain `node:http` request handler.
 * Stateless: every request re-reads the mounted dnsmasq log and blacklist, so
 * the host-mounted files stay the single source of truth. Blacklist mutations
 * hand the change to the entrypoint via SIGHUP, which restarts dnsmasq
 * (dnsmasq itself never re-reads `--conf-dir` on SIGHUP).
 *
 * Only Node built-ins are used: the handler is bundled into a single
 * dependency-free `.mjs` that runs inside the `node:24-alpine` egress image.
 */

import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  appendBlacklistDomain,
  parseBlacklistDomains,
  removeBlacklistDomain,
} from '../contract/blacklist.js';
import {
  EGRESS_BLACKLIST_MOUNT,
  EGRESS_DNSMASQ_LOG,
} from '../contract/constants.js';
import { isValidDomain } from '../contract/domain.js';
import { parseDnsmasqLog } from '../contract/logParser.js';
import { applyLogQuery, squashEntries } from '../contract/squash.js';
import type {
  BlacklistAddRequest,
  BlacklistDomainsResponse,
  EgressLogEntry,
  ErrorResponse,
  LogQuery,
  SquashedEntry,
  StatusResponse,
} from '../contract/types.js';

import {
  decodeSegment,
  readBody,
  withErrorTail,
  writeJson,
  type JsonSender,
  type SidecarHandler,
} from '../../http.js';

/** Everything the handler touches outside its own process, so tests can swap it. */
export interface EgressApiOptions {
  /** The dnsmasq query log (default: the mounted log). */
  logFile?: string;
  /** The dnsmasq blacklist conf file (default: the mounted blacklist). */
  blacklistFile?: string;
  /** Asks the entrypoint to restart dnsmasq (default: SIGHUP to PID 1). */
  reload?: () => void;
}

const BLACKLIST_DOMAINS_PATH = '/blacklist/domains';
const BLACKLIST_DOMAIN_RE = /^\/blacklist\/domains\/([^/]+)$/;

/** Every body the egress routes can answer with. */
type EgressResponseBody =
  | EgressLogEntry[]
  | SquashedEntry[]
  | BlacklistDomainsResponse
  | StatusResponse
  | ErrorResponse;

/** The shared JSON writer, pinned to this API's contract. */
const sendJson: JsonSender<EgressResponseBody> = writeJson;

function readFileOrEmpty(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
}

/** Default reload: the entrypoint is PID 1 and traps HUP to restart dnsmasq. */
function signalEntrypoint(): void {
  try {
    process.kill(1, 'SIGHUP');
  } catch {
    // Not running under the entrypoint (tests, local debugging): nothing to reload.
  }
}

/** Builds the request handler; `http.createServer(createEgressApi())`. */
export function createEgressApi(
  options: EgressApiOptions = {}
): SidecarHandler {
  const logFile = options.logFile ?? EGRESS_DNSMASQ_LOG;
  const blacklistFile = options.blacklistFile ?? EGRESS_BLACKLIST_MOUNT;
  const reload = options.reload ?? signalEntrypoint;

  const readLog = (): EgressLogEntry[] =>
    parseDnsmasqLog(
      readFileOrEmpty(logFile),
      parseBlacklistDomains(readFileOrEmpty(blacklistFile))
    );

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'Invalid URL' });
    }
    const { pathname } = url;
    const method = req.method ?? 'GET';

    if (pathname === '/health' && method === 'GET') {
      return sendJson(res, 200, { status: 'ok' });
    }

    if (pathname === '/logs' && method === 'GET') {
      const query: LogQuery = Object.fromEntries(url.searchParams);
      if (query.since !== undefined && Number.isNaN(Date.parse(query.since))) {
        return sendJson(res, 400, { error: 'Invalid since timestamp' });
      }
      return sendJson(res, 200, applyLogQuery(readLog(), query));
    }

    if (pathname === '/logs/squashed' && method === 'GET') {
      return sendJson(res, 200, squashEntries(readLog()));
    }

    if (pathname === BLACKLIST_DOMAINS_PATH && method === 'GET') {
      return sendJson(res, 200, {
        domains: parseBlacklistDomains(readFileOrEmpty(blacklistFile)),
      });
    }

    if (pathname === BLACKLIST_DOMAINS_PATH && method === 'POST') {
      // Read outside the try: a body past the cap is not malformed JSON, and
      // the shared error tail is what answers it - for both sidecars alike.
      const raw = await readBody(req);
      let domain: string | undefined;
      try {
        ({ domain } = JSON.parse(raw) as Partial<BlacklistAddRequest>);
      } catch {
        return sendJson(res, 400, { error: 'Invalid JSON body' });
      }
      if (typeof domain !== 'string' || domain.trim() === '') {
        return sendJson(res, 400, { error: 'Missing domain' });
      }
      if (!isValidDomain(domain.trim())) {
        return sendJson(res, 400, { error: 'Invalid domain' });
      }
      const content = readFileOrEmpty(blacklistFile);
      const next = appendBlacklistDomain(content, domain.trim());
      if (next !== content) fs.writeFileSync(blacklistFile, next);
      reload();
      return sendJson(res, 200, { status: 'ok' });
    }

    const domainMatch = BLACKLIST_DOMAIN_RE.exec(pathname);
    if (domainMatch && method === 'DELETE') {
      const domain = decodeSegment(domainMatch[1]);
      if (domain === null || !isValidDomain(domain)) {
        return sendJson(res, 400, { error: 'Invalid domain' });
      }
      fs.writeFileSync(
        blacklistFile,
        removeBlacklistDomain(readFileOrEmpty(blacklistFile), domain)
      );
      reload();
      return sendJson(res, 200, { status: 'ok' });
    }

    return sendJson(res, 404, { error: 'Not found' });
  };

  return withErrorTail(handle);
}
