/**
 * The **egress HTTP API** (ADR-0012). Runs inside the `e-egress` container.
 * Provides stateless query/mutation over the mounted dnsmasq log and the
 * host-mounted blacklist file. No resident tailer, no persistence.
 */
import express from 'express';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import { parseDnsmasqLog, toISO8601 } from './logParser.js';
import { squashEntries } from './squash.js';
import {
  EGRESS_DNSMASQ_LOG,
  EGRESS_BLACKLIST_MOUNT,
  EGRESS_API_PORT,
  parseBlacklist,
} from './index.js';
import { appendBlacklistDomain, removeBlacklistDomain } from './blacklist.js';
import type { EgressLogEntry, SquashedEntry, LogQuery } from './logParser.js';

/**
 * Parse dnsmasq log content and classify entries against the blacklist.
 * Returns structured entries with allow/deny(sinkholed) action.
 */
function readAndParseLog(): EgressLogEntry[] {
  if (!fs.existsSync(EGRESS_DNSMASQ_LOG)) return [];
  const raw = fs.readFileSync(EGRESS_DNSMASQ_LOG, 'utf-8');
  const blacklistContent = fs.existsSync(EGRESS_BLACKLIST_MOUNT)
    ? fs.readFileSync(EGRESS_BLACKLIST_MOUNT, 'utf-8')
    : '';
  const blacklist = parseBlacklist(blacklistContent);
  const blacklistDomains = new Set(
    blacklist.domains.map(d => d.toLowerCase().replace(/\.$/, ''))
  );
  return parseDnsmasqLog(raw, blacklistDomains);
}

/** Apply filters to a list of entries (ADR-0012: since/domain/action/limit). */
function applyLogQuery(
  entries: EgressLogEntry[],
  query?: LogQuery
): EgressLogEntry[] {
  if (!query) {
    return entries
  }
  
  let result = entries;
  if (query.since) {
    const since = new Date(query.since).getTime();
    result = result.filter(e => new Date(e.timestamp).getTime() >= since);
  }
  if (query.domain) {
    result = result.filter(e => e.domain === query.domain);
  }
  if (query.action) {
    result = result.filter(e => e.action === query.action);
  }
  if (query.limit) {
    result = result.slice(-Number(query.limit));
  }
  return result;
}

/** Trigger dnsmasq SIGHUP reload after blacklist file edit. */
function triggerReload(callback: (err: Error | null) => void): void {
  // The egress entrypoint traps HUP to re-apply iptables + reload dnsmasq.
  // In the local stack the pid file is at /run/dnsmasq.pid.
  exec('kill -HUP $(cat /run/dnsmasq.pid 2>/dev/null) || true', callback);
}

/** Create the egress API Express application (ADR-0012). */
export function createEgressApiApp(): express.Express {
  const app = express();
  app.use(express.json());

  // Health probe for the egress container's own API listener.
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // GET /logs — mapped log entries with filters (ADR-0012).
  app.get('/logs', (req, res) => {
    try {
      const query = req.query as unknown as LogQuery;
      const entries = applyLogQuery(readAndParseLog(), query);
      const squashed = squashEntries(entries);
      res.json(squashed);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /logs/squashed — rollup of consecutive same-domain entries,
  // localhost noise dropped (ADR-0012).
  app.get('/logs/squashed', (_req, res) => {
    try {
      const entries = readAndParseLog();
      const squashed = squashEntries(entries);
      res.json(squashed);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /blacklist/domains — add a domain, SIGHUP reload (ADR-0012).
  app.get('/blacklist/domains', (_req, res) => {
    try {
      const content = fs.existsSync(EGRESS_BLACKLIST_MOUNT)
        ? fs.readFileSync(EGRESS_BLACKLIST_MOUNT, 'utf-8')
        : '';
      const lines = content
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && !l.startsWith(';'));
      res.json({ domains: lines });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/blacklist/domains', (req, res) => {
    try {
      const { domain } = req.body;
      if (!domain) {
        return res.status(400).json({ error: 'Missing domain' });
      }
      const content = fs.existsSync(EGRESS_BLACKLIST_MOUNT)
        ? fs.readFileSync(EGRESS_BLACKLIST_MOUNT, 'utf-8')
        : '';
      const newContent = appendBlacklistDomain(content, domain);
      fs.writeFileSync(EGRESS_BLACKLIST_MOUNT, newContent);
      triggerReload(err => {
        if (err) {
          return res.json({ status: 'updated', reload: 'manual_required' });
        }
        res.json({ status: 'ok' });
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // DELETE /blacklist/domains/:domain — remove a domain, SIGHUP reload (ADR-0012).
  app.delete('/blacklist/domains/:domain', (req, res) => {
    try {
      const { domain } = req.params;
      if (!domain) {
        return res.status(400).json({ error: 'Missing domain' });
      }
      if (!fs.existsSync(EGRESS_BLACKLIST_MOUNT)) {
        return res.json({ status: 'ok' });
      }
      const content = fs.readFileSync(EGRESS_BLACKLIST_MOUNT, 'utf-8');
      const newContent = removeBlacklistDomain(content, domain);
      fs.writeFileSync(EGRESS_BLACKLIST_MOUNT, newContent);
      triggerReload(err => {
        if (err) {
          return res.json({ status: 'updated', reload: 'manual_required' });
        }
        res.json({ status: 'ok' });
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return app;
}

/** Start the egress API server (for direct container entrypoint use). */
export function startEgressApiServer(): void {
  const app = createEgressApiApp();
  app.listen(EGRESS_API_PORT, '0.0.0.0', () => {
    console.log(`Egress API listening on port ${EGRESS_API_PORT}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startEgressApiServer();
}

// Re-export for consumers
export { toISO8601 };
export type { EgressLogEntry, SquashedEntry, LogQuery };
