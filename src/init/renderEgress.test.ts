import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  renderEgressDockerfile,
  renderEgressEntrypoint,
  renderDnsmasqBaseConf,
  renderEgressApiJs,
  renderEgressFiles,
  renderBlacklistExample,
} from './renderEgress.js';

test('renderEgressDockerfile: node/alpine base with dnsmasq + iptables, entrypoint set', () => {
  const df = renderEgressDockerfile();
  assert.match(df, /FROM node:.*-alpine/);
  assert.match(df, /apk add --no-cache .*\bdnsmasq\b.*\biptables\b/);
  assert.match(df, /ENTRYPOINT \["\/egress-entrypoint.sh"\]/);
  assert.doesNotMatch(df, /VOLUME.*\/etc\/egress\.d/);
});

test('renderEgressEntrypoint: wires the mounted iptables script into an EGRESS chain', () => {
  const ep = renderEgressEntrypoint();
  assert.match(ep, /iptables -N EGRESS/);
  assert.match(ep, /iptables -I OUTPUT -j EGRESS/);
  assert.match(ep, /\/etc\/egress\.d\/iptables\.rules/);
  assert.match(ep, /dnsmasq -k -d/);
  assert.match(ep, /\/var\/log\/egress\/dnsmasq\.log/);
});

test('renderEgressEntrypoint: stays PID 1 and restarts dnsmasq on SIGHUP instead of exec-ing into it (dnsmasq SIGHUP never re-reads --conf-dir)', () => {
  const ep = renderEgressEntrypoint();
  // Never hands PID 1 to dnsmasq — that would make a restart-on-HUP impossible.
  assert.doesNotMatch(ep, /\bexec dnsmasq\b/);
  assert.match(ep, /trap 'restart_dnsmasq' HUP/);
  assert.match(ep, /DNSMASQ_PID=\$!/);
  // The restart path re-applies iptables too, kills the old child, and waits
  // for it to actually exit (so the new one can rebind port 53) before
  // starting a replacement.
  assert.match(
    ep,
    /restart_dnsmasq\(\) \{[\s\S]*apply_ip_rules[\s\S]*kill "\$\{DNSMASQ_PID\}"[\s\S]*while kill -0 "\$\{DNSMASQ_PID\}"[\s\S]*start_dnsmasq/
  );
  // Forwards a container stop signal to the dnsmasq child instead of leaking it.
  assert.match(ep, /trap 'kill "\$\{DNSMASQ_PID\}".*TERM INT/);
});

test('renderEgressEntrypoint: is valid POSIX shell (both host sh and busybox)', () => {
  const ep = renderEgressEntrypoint();
  const tmp = path.join(os.tmpdir(), `e-entrypoint-${process.pid}.sh`);
  fs.writeFileSync(tmp, ep);
  try {
    execFileSync('sh', ['-n', tmp]);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('renderDnsmasqBaseConf: binds loopback and avoids an embedded-DNS forwarding loop', () => {
  const conf = renderDnsmasqBaseConf();
  assert.match(conf, /bind-interfaces/);
  assert.match(conf, /listen-address=127\.0\.0\.1/);
  assert.match(conf, /server=1\.1\.1\.1/);
  assert.match(conf, /server=8\.8\.8\.8/);
  assert.doesNotMatch(conf, /server=127\.0\.0\.11/);
});

test('renderEgressApiJs: GET /blacklist/domains lists domains alongside the POST/DELETE mutators', () => {
  const api = renderEgressApiJs();
  assert.match(api, /postMatch && req\.method === 'GET'/);
  assert.match(
    api,
    /sendJson\(res, 200, \{domains: parseBlacklistDomains\(content\)\}\)/
  );
  assert.match(api, /postMatch && req\.method === 'POST'/);
  assert.match(api, /delMatch && req\.method === 'DELETE'/);
});

test("renderEgressApiJs: QUERY_RE/REPLY_RE match dnsmasq's actual --log-facility=<file> format (no syslog hostname field)", () => {
  const api = renderEgressApiJs();
  const extractRegex = (name: string): RegExp => {
    const m = new RegExp(`const ${name} = (/.*/);`).exec(api);
    assert.ok(m, `${name} not found in rendered script`);
    return eval(m[1]);
  };
  const queryRe = extractRegex('QUERY_RE');
  const replyRe = extractRegex('REPLY_RE');

  const queryLine =
    'Sep  7 15:00:00 dnsmasq[1]: query[A] oidc.us-east-1.amazonaws.com from 127.0.0.1';
  const replyLine =
    'Sep 11 16:15:23 dnsmasq[1]: reply registry.npmjs.org is 104.16.7.34';

  const queryMatch = queryRe.exec(queryLine);
  assert.ok(
    queryMatch,
    'QUERY_RE must match a real dnsmasq log-facility query line'
  );
  assert.equal(queryMatch[1], 'oidc.us-east-1.amazonaws.com');

  const replyMatch = replyRe.exec(replyLine);
  assert.ok(
    replyMatch,
    'REPLY_RE must match a real dnsmasq log-facility reply line'
  );
  assert.equal(replyMatch[1], 'registry.npmjs.org');
});

test('renderEgressApiJs: parseBlacklistDomains extracts domains from dnsmasq address= directives (the format actually written and required by --conf-dir)', () => {
  const api = renderEgressApiJs();
  const m = /function parseBlacklistDomains\(content\) \{[\s\S]*?\n\}\n/.exec(
    api
  );
  assert.ok(m, 'parseBlacklistDomains not found in rendered script');
  const parseBlacklistDomains = new Function(
    'content',
    `${m[0]}\nreturn parseBlacklistDomains(content);`
  ) as (content: string) => string[];

  assert.deepEqual(parseBlacklistDomains('address=/example.com/0.0.0.0\n'), [
    'example.com',
  ]);
  assert.deepEqual(
    parseBlacklistDomains(
      '# comment\naddress=/foo.com/0.0.0.0\naddress=/bar.com/0.0.0.0\n'
    ),
    ['foo.com', 'bar.com']
  );
  // One domain yields an A and an AAAA sinkhole line; it must list once.
  assert.deepEqual(
    parseBlacklistDomains('address=/foo.com/0.0.0.0\naddress=/foo.com/::\n'),
    ['foo.com']
  );
  // A bare domain line is never written by this API anymore, but stays
  // tolerated for classification purposes if a file has one by hand.
  assert.deepEqual(parseBlacklistDomains('plain-domain.example\n'), [
    'plain-domain.example',
  ]);
});

test('renderEgressApiJs: POST writes a dnsmasq address= directive, not a bare domain (a bare line crashes dnsmasq --conf-dir)', () => {
  const api = renderEgressApiJs();
  assert.match(api, /'address=\/' \+ norm \+ '\/0\.0\.0\.0\\n'/);
  assert.match(
    api,
    /if \(!parseBlacklistDomains\(content\)\.includes\(norm\)\)/
  );
});

test('renderEgressApiJs: POST sinkholes both address families (an IPv4-only entry leaves the domain reachable over IPv6)', () => {
  const api = renderEgressApiJs();
  assert.match(api, /'address=\/' \+ norm \+ '\/::\\n'/);
});

test('renderEgressApiJs: DELETE matches the address= directive by its embedded domain', () => {
  const api = renderEgressApiJs();
  assert.match(api, /address=\\\/\(\[\^\/\]\+\)\\\//);
});

test('renderBlacklistExample: documents the dnsmasq address= directive for both address families, not a bare domain', () => {
  const example = renderBlacklistExample();
  assert.match(example, /address=\/example\.com\/0\.0\.0\.0/);
  assert.match(example, /address=\/example\.com\/::/);
  assert.doesNotMatch(example, /^example\.com\s*$/m);
});

test('renderEgressFiles: renders exactly the four build-context files', () => {
  const files = renderEgressFiles();
  assert.deepEqual(Object.keys(files).sort(), [
    'Dockerfile',
    'blacklist.example',
    'dnsmasq.conf',
    'egress-api.mjs',
    'entrypoint.sh',
  ]);
});
