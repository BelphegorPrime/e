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
} from './blacklist.js';
import { EGRESS_BLACKLIST_MOUNT, EGRESS_DNSMASQ_LOG } from './constants.js';
import { isValidDomain } from './domain.js';
import { parseDnsmasqLog } from './logParser.js';
import { applyLogQuery, squashEntries } from './squash.js';
import type {
  BlacklistAddRequest,
  BlacklistDomainsResponse,
  EgressLogEntry,
  ErrorResponse,
  LogQuery,
  SquashedEntry,
  StatusResponse,
} from './types.js';

/** Everything the handler touches outside its own process, so tests can swap it. */
export interface EgressApiOptions {
  /** The dnsmasq query log (default: the mounted log). */
  logFile?: string;
  /** The dnsmasq blacklist conf file (default: the mounted blacklist). */
  blacklistFile?: string;
  /** Asks the entrypoint to restart dnsmasq (default: SIGHUP to PID 1). */
  reload?: () => void;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const BLACKLIST_DOMAINS_PATH = '/blacklist/domains';
const BLACKLIST_DOMAIN_RE = /^\/blacklist\/domains\/([^/]+)$/;
/** A blacklist mutation body is one short JSON object; anything bigger is abuse. */
const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLarge extends Error {}

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

function sendJson(
  res: ServerResponse,
  status: number,
  body:
    | EgressLogEntry[]
    | SquashedEntry[]
    | BlacklistDomainsResponse
    | StatusResponse
    | ErrorResponse
): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer | string) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new BodyTooLarge('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** Decodes a path segment; `null` for malformed percent-escapes (a URIError). */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Builds the request handler; `http.createServer(createEgressApi())`. */
export function createEgressApi(options: EgressApiOptions = {}): Handler {
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
      let domain: string | undefined;
      try {
        ({ domain } = JSON.parse(
          await readBody(req)
        ) as Partial<BlacklistAddRequest>);
      } catch (err) {
        if (err instanceof BodyTooLarge) {
          return sendJson(res, 413, { error: err.message });
        }
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

  return (req, res) => {
    handle(req, res).catch(err => {
      if (!res.headersSent) sendJson(res, 500, { error: errorMessage(err) });
      else res.end();
    });
  };
}
