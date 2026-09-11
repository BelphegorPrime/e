/**
 * Renders the **egress gateway** build context (ADR-0011): a Dockerfile,
 * an entrypoint script, a dnsmasq config, a blacklist template, and an
 * embedded Node.js egress API server (ADR-0012) — all seeded into `.e/egress/`
 * mirroring how harness/mcp build contexts are seeded (never clobbered, so a
 * user can edit them). The rendered image `e-egress` is built once and started
 * once as a global stack service; every stack service and run agent joins the
 * egress netns and routes all outbound through it.
 *
 * The rendered artifacts:
 *
 *  - `Dockerfile` — Alpine + `nodejs` + `dnsmasq` + `iptables`, non-root is NOT
 *    applied here by design: the egress container is ours (trusted), and
 *    iptables needs `NET_ADMIN` in its own netns (added at run time, never on
 *    the agent).
 *  - `entrypoint.sh` — applies the mounted iptables blacklist to its own netns,
 *    starts the egress API server (ADR-0012) in the background, re-applies
 *    iptables + reloads dnsmasq on SIGHUP, then runs `dnsmasq` in the foreground
 *    with query logging to the mounted log dir and its blacklist conf-dir read
 *    from the mounted blacklist file.
 *  - `dnsmasq.conf` — the base dnsmasq config with independent upstream
 *    resolvers.
 *  - `egress-api.js` — the egress HTTP API server (ADR-0012). Stateless: reads
 *    the mounted dnsmasq log + blacklist per request, serves query + mutation
 *    endpoints, triggers SIGHUP reload after blacklist edits.
 *  - `blacklist.example` — a commented template documenting the format.
 */

import {
  EGRESS_BLACKLIST_IP_MOUNT,
  EGRESS_LOG_MOUNT,
  EGRESS_API_PORT,
} from '../egress/index.js';
import Mustache from 'mustache';

const DOCKERFILE_TEMPLATE = `# The egress gateway container (ADR-0011). A single global service; all
# stack services and run agents share its network namespace, so a blacklist here
# is enforced and every query / connection is logged host-side.
FROM alpine:3.20

RUN apk add --no-cache nodejs npm dnsmasq iptables ip6tables bash

COPY entrypoint.sh /egress-entrypoint.sh
COPY dnsmasq.conf /etc/egress.d/dnsmasq.conf
COPY egress-api.js /egress-api.js
RUN chmod +x /egress-entrypoint.sh

# Compose mounts the blacklist file and log directory explicitly. Do not declare
# /etc/egress.d as a VOLUME: Docker would preserve an anonymous volume across
# container recreation, masking rebuilt dnsmasq.conf files with stale content.

# iptables needs NET_ADMIN in this container's own netns (added by the runtime).
ENTRYPOINT ["/egress-entrypoint.sh"]
`;

const DNSMASQ_BASE_CONF_TEMPLATE = `# Base dnsmasq config for the egress gateway (ADR-0011).
# The mounted blacklist (address=/domain/0.0.0.0 lines) is read from
# the conf-dir; log-queries records every query to the mounted log.
#
# Containers query the engine's embedded DNS first. It resolves container
# aliases itself and forwards public names to dnsmasq because compose configures
# 127.0.0.1 as its external resolver. dnsmasq must therefore use independent
# upstreams: forwarding back to the embedded resolver creates a DNS loop.
port=53
bind-interfaces
listen-address=127.0.0.1
no-resolv
no-poll
server=1.1.1.1
server=8.8.8.8
`;

const BLACKLIST_EXAMPLE_TEMPLATE = `# Egress blacklist for e runs (ADR-0011).
#
# One entry per line. A domain line is sinkholed by dnsmasq (blocks the domain
# and all its subdomains, resolves to 0.0.0.0 so the connection fails fast and
# is logged). An IPv4:port line is REJECTed by iptables (catches direct-IP
# connections that bypass DNS entirely). '#' and ';' start a comment; blank
# lines are ignored. This file is never clobbered by e init.
#
# example.com            # blocks example.com and *.example.com
# 203.0.113.7:8443       # rejects the direct IP:port
`;

/** Egress API server script rendered into the container (ADR-0012). */
const EGGRESS_API_TEMPLATE = `/* Egress HTTP API (ADR-0012). Stateless: reads mounted log +
 * blacklist per request, serves query + mutation endpoints. Runs inside
 * the e-egress container alongside dnsmasq.
 */
const http = require('http');
const fs = require('fs');
const { exec } = require('child_process');

const LOG_FILE = '/var/log/egress/dnsmasq.log';
const BLACKLIST_FILE = '/etc/egress.d/dnsmasq.blacklist';
const PORT = {{{egressApiPort}}};

const QUERY_RE = /^\\w{3}\\s+\\d+\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\S+\\s+dnsmasq\\[\\d+\\]:\\s+query\\[[^\\]]+\\]\\s+(\\S+)\\s+from\\s+/;
const REPLY_RE = /^\\w{3}\\s+\\d+\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\S+\\s+dnsmasq\\[\\d+\\]:\\s+reply\\s+(\\S+)\\s+is\\s+/;
const MONTH_MAP = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};

const LOCAL_NAMES = ['localhost', 'localhost.localdomain'];

function toISO8601(ts) {
  const m = /^(\\w{3})\\s+(\\d+)\\s+(\\d{2}:\\d{2}:\\d{2})/.exec(ts.trim());
  if (!m) return ts;
  const month = MONTH_MAP[m[1]];
  if (month === undefined) return ts;
  const parts = m[3].split(':').map(Number);
  const year = new Date().getFullYear();
  return new Date(Date.UTC(year, month, parseInt(m[2]), parts[0], parts[1], parts[2])).toISOString();
}

function parseLogLine(line) {
  const qm = QUERY_RE.exec(line);
  const rm = REPLY_RE.exec(line);
  let domain = null;
  if (qm) domain = qm[1];
  else if (rm) domain = rm[1];
  if (!domain) return null;

  const tsMatch = /^(\\w{3}\\s+\\d+\\s+\\d{2}:\\d{2}:\\d{2})/.exec(line);
  const timestamp = tsMatch ? toISO8601(tsMatch[1]) : '';
  return { timestamp, runID: '', domain, protocol: 'DNS', action: '' };
}

function parseBlacklistDomains(content) {
  const domains = [];
  for (const raw of content.split('\\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.includes(':')) {
      const idx = line.lastIndexOf(':');
      const portPart = line.slice(idx + 1);
      const ipPart = line.slice(0, idx);
      if (/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(ipPart) && /^\\d+$/.test(portPart) && parseInt(portPart) > 0 && parseInt(portPart) <= 65535) continue;
    }
    domains.push(line.toLowerCase().replace(/\\.$/, ''));
  }
  return domains;
}

function isSinkholed(domain, blacklistDomains) {
  const norm = domain.toLowerCase().replace(/\\.$/, '');
  return blacklistDomains.some(b => norm === b || norm.endsWith('.' + b));
}

function readLog() {
  if (!fs.existsSync(LOG_FILE)) return [];
  const raw = fs.readFileSync(LOG_FILE, 'utf-8');
  const blContent = fs.existsSync(BLACKLIST_FILE) ? fs.readFileSync(BLACKLIST_FILE, 'utf-8') : '';
  const blacklistDomains = parseBlacklistDomains(blContent);
  const entries = [];
  for (const line of raw.split('\\n')) {
    const entry = parseLogLine(line);
    if (!entry) continue;
    entry.action = isSinkholed(entry.domain, blacklistDomains) ? 'deny(sinkholed)' : 'allow';
    entries.push(entry);
  }
  return entries;
}

function isLocalhost(domain) {
  const norm = domain.toLowerCase().replace(/\\.$/, '');
  return LOCAL_NAMES.some(l => norm === l || norm.endsWith('.' + l));
}

function applyQuery(entries, q) {
  let result = entries;
  if (q.since) {
    const since = new Date(q.since).getTime();
    result = result.filter(e => new Date(e.timestamp).getTime() >= since);
  }
  if (q.domain) result = result.filter(e => e.domain === q.domain);
  if (q.action) result = result.filter(e => e.action === q.action);
  if (q.limit) result = result.slice(-Number(q.limit));
  return result;
}

function sendJson(res, status, obj) {
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify(obj));
}

function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/health') {
    return sendJson(res, 200, {status: 'ok'});
  }

  if (pathname === '/logs') {
    try {
      const query = Object.fromEntries(url.searchParams.entries());
      const entries = applyQuery(readLog(), query);
      sendJson(res, 200, entries);
    } catch (err) {
      sendJson(res, 500, {error: String(err)});
    }
    return;
  }

  if (pathname === '/logs/squashed') {
    try {
      const entries = readLog();
      const squashed = [];
      let current = null;
      for (const e of entries) {
        if (isLocalhost(e.domain)) continue;
        if (current && current.domain === e.domain) {
          current.count++;
          current.lastSeen = e.timestamp;
        } else {
          current = {domain: e.domain, count: 1, firstSeen: e.timestamp, lastSeen: e.timestamp};
          squashed.push(current);
        }
      }
      sendJson(res, 200, squashed);
    } catch (err) {
      sendJson(res, 500, {error: String(err)});
    }
    return;
  }

  const postMatch = pathname.match(/^\\/blacklist\\/domains$/);
  const delMatch = pathname.match(/^\\/blacklist\\/domains\\/([^/]+)$/);

  if (postMatch && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { domain } = JSON.parse(body);
        if (!domain) return sendJson(res, 400, {error: 'Missing domain'});
        const content = fs.existsSync(BLACKLIST_FILE) ? fs.readFileSync(BLACKLIST_FILE, 'utf-8') : '';
        const norm = domain.toLowerCase().replace(/\\.$/, '');
        const lines = content.trim().split('\\n').filter(l => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith(';'));
        if (!lines.includes(norm)) {
          const newContent = (content ? content.trimEnd() + '\\n' : '') + norm + '\\n';
          fs.writeFileSync(BLACKLIST_FILE, newContent);
        }
        try { exec('kill -HUP $(cat /run/dnsmasq.pid 2>/dev/null)', {stdio: 'ignore'); } catch (e) {}
        sendJson(res, 200, {status: 'ok'});
      } catch (err) {
        sendJson(res, 500, {error: String(err)});
      }
    });
    return;
  }

  if (delMatch && req.method === 'DELETE') {
    try {
      const domain = decodeURIComponent(delMatch[1]);
      const content = fs.existsSync(BLACKLIST_FILE) ? fs.readFileSync(BLACKLIST_FILE, 'utf-8') : '';
      const norm = domain.toLowerCase().replace(/\\.$/, '');
      const newContent = content.split('\\n').filter(line => {
        const t = line.trim().toLowerCase().replace(/\\.$/, '');
        return t !== norm;
      }).join('\\n') + (content.trim() ? '\\n' : '');
      fs.writeFileSync(BLACKLIST_FILE, newContent);
      try { exec('kill -HUP $(cat /run/dnsmasq.pid 2>/dev/null)', {stdio: 'ignore'); } catch (e) {}
      sendJson(res, 200, {status: 'ok'});
    } catch (err) {
      sendJson(res, 500, {error: String(err)});
    }
    return;
  }

  sendJson(res, 404, {error: 'Not found'});
}

http.createServer(handleRequest).listen(PORT, '0.0.0.0', () => {
  console.log('Egress API listening on port ' + PORT);
});
`;

const ENTRYPOINT_TEMPLATE = `#!/bin/sh
# Egress gateway entrypoint (ADR-0011). Applies the mounted iptables blacklist
# to this netns, starts the egress HTTP API (ADR-0012) in the background, then
# runs dnsmasq in the foreground with query logging. All stack services and
# run agents share this container's network namespace, so every DNS query and
# connection crosses here and is logged / blocked.
set -eu

IP_BLACKLIST="{{{blacklistIpMount}}}"
DNSMASQ_CONF="/etc/egress.d/dnsmasq.conf"

apply_ip_rules() {
  # Hook a dedicated EGRESS chain into OUTPUT once, then (re)apply the mounted
  # rules. Using a chain (not \`iptables -F OUTPUT\`) never clobbers the engine's
  # own netns rules (e.g. the embedded-DNS path Docker wires in the same netns).
  iptables -N EGRESS 2>/dev/null || iptables -F EGRESS
  iptables -C OUTPUT -j EGRESS 2>/dev/null || iptables -I OUTPUT -j EGRESS
  if [ -f "\${IP_BLACKLIST}" ]; then
    sh "\${IP_BLACKLIST}" || true
  fi
  echo "egress: applied iptables blacklist \${IP_BLACKLIST}" >&2
}

apply_ip_rules

# Start the egress HTTP API (ADR-0012) in the background.
node /egress-api.js &

# Reload dnsmasq + re-apply iptables on SIGHUP so a host edit to the mounted
# blacklist takes effect without restarting the shared netns.
trap 'apply_ip_rules; kill -HUP $(cat /run/dnsmasq.pid 2>/dev/null) 2>/dev/null || true' HUP

mkdir -p "{{{logMount}}}"
# -k keep running, -d don't daemonize. --conf-file reads the base config
# (bind-interfaces + listen-address=127.0.0.1, so it never clashes with the
# engine's embedded DNS at 127.0.0.11 in the same netns); --conf-dir reads the
# mounted *.blacklist for sinkhole address lines.
exec dnsmasq -k -d \\
  --conf-file="\${DNSMASQ_CONF}" \\
  --conf-dir=/etc/egress.d/,*.blacklist \\
  --log-queries \\
  --log-facility="{{{logMount}}}/dnsmasq.log"
`;

/** Renders the `entrypoint.sh` for the egress container. */
export function renderEgressEntrypoint(): string {
  return Mustache.render(ENTRYPOINT_TEMPLATE, {
    blacklistIpMount: EGRESS_BLACKLIST_IP_MOUNT,
    logMount: EGRESS_LOG_MOUNT,
  });
}

/** Renders the egress API server script (ADR-0012). */
export function renderEgressApiJs(): string {
  return Mustache.render(EGGRESS_API_TEMPLATE, {
    egressApiPort: EGRESS_API_PORT,
  });
}

/** Renders the base `dnsmasq.conf` for the egress container. */
export function renderDnsmasqBaseConf(): string {
  return Mustache.render(DNSMASQ_BASE_CONF_TEMPLATE, {});
}

/** Renders the `Dockerfile` for the egress container. */
export function renderEgressDockerfile(): string {
  return Mustache.render(DOCKERFILE_TEMPLATE, {});
}

/** Renders the user-facing blacklist template seeded as `blacklist.example`. */
export function renderBlacklistExample(): string {
  return Mustache.render(BLACKLIST_EXAMPLE_TEMPLATE, {});
}

/** The files `e init` writes into `.e/egress/`, keyed by file name. */
export function renderEgressFiles(): Record<string, string> {
  return {
    Dockerfile: renderEgressDockerfile(),
    'entrypoint.sh': renderEgressEntrypoint(),
    'dnsmasq.conf': renderDnsmasqBaseConf(),
    'egress-api.js': renderEgressApiJs(),
    'blacklist.example': renderBlacklistExample(),
  };
}
