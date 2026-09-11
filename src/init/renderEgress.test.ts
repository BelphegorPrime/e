import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  EGRESS_FILES,
  renderEgressDockerfile,
  renderEgressEntrypoint,
  renderDnsmasqBaseConf,
  renderEgressApiJs,
  renderEgressFiles,
  renderBlacklistExample,
} from './renderEgress.js';
import {
  EGRESS_API_PORT,
  EGRESS_BLACKLIST_IP_MOUNT,
  EGRESS_BLACKLIST_MOUNT,
  EGRESS_DNSMASQ_LOG,
} from '../egress/constants.js';

function withTempFile<T>(
  name: string,
  content: string,
  fn: (file: string) => T
): T {
  const tmp = path.join(os.tmpdir(), `e-${process.pid}-${name}`);
  fs.writeFileSync(tmp, content);
  try {
    return fn(tmp);
  } finally {
    fs.unlinkSync(tmp);
  }
}

test('renderEgressDockerfile: node/alpine base with dnsmasq + iptables, copies every rendered file it needs, entrypoint set', () => {
  const df = renderEgressDockerfile();
  assert.match(df, /FROM node:.*-alpine/);
  assert.match(df, /apk add --no-cache .*\bdnsmasq\b.*\biptables\b/);
  assert.match(df, new RegExp(`COPY ${EGRESS_FILES.entrypoint} `));
  assert.match(df, new RegExp(`COPY ${EGRESS_FILES.dnsmasqConf} `));
  assert.match(
    df,
    new RegExp(`COPY ${EGRESS_FILES.apiScript} /egress-api\\.mjs`)
  );
  assert.match(df, /ENTRYPOINT \["\/egress-entrypoint.sh"\]/);
  assert.doesNotMatch(df, /VOLUME.*\/etc\/egress\.d/);
});

test('renderEgressEntrypoint: wires the mounted iptables script into an EGRESS chain and logs to the shared log path', () => {
  const ep = renderEgressEntrypoint();
  assert.match(ep, /iptables -N EGRESS/);
  assert.match(ep, /iptables -I OUTPUT -j EGRESS/);
  assert.ok(ep.includes(`IP_BLACKLIST="${EGRESS_BLACKLIST_IP_MOUNT}"`));
  assert.match(ep, /dnsmasq -k -d/);
  assert.ok(ep.includes(`--log-facility="${EGRESS_DNSMASQ_LOG}"`));
  assert.match(ep, /node \/egress-api\.mjs &/);
});

test('renderEgressEntrypoint: stays PID 1 and restarts dnsmasq on SIGHUP instead of exec-ing into it (dnsmasq SIGHUP never re-reads --conf-dir)', () => {
  const ep = renderEgressEntrypoint();
  assert.doesNotMatch(ep, /\bexec dnsmasq\b/);
  assert.match(ep, /trap 'restart_dnsmasq' HUP/);
  assert.match(ep, /DNSMASQ_PID=\$!/);
  assert.match(
    ep,
    /restart_dnsmasq\(\) \{[\s\S]*apply_ip_rules[\s\S]*kill "\$\{DNSMASQ_PID\}"[\s\S]*while kill -0 "\$\{DNSMASQ_PID\}"[\s\S]*start_dnsmasq/
  );
  assert.match(ep, /trap 'kill "\$\{DNSMASQ_PID\}".*TERM INT/);
});

test('renderEgressEntrypoint: is valid POSIX shell (both host sh and busybox)', () => {
  withTempFile('entrypoint.sh', renderEgressEntrypoint(), file => {
    execFileSync('sh', ['-n', file]);
  });
});

test('renderDnsmasqBaseConf: binds loopback and avoids an embedded-DNS forwarding loop', () => {
  const conf = renderDnsmasqBaseConf();
  assert.match(conf, /bind-interfaces/);
  assert.match(conf, /listen-address=127\.0\.0\.1/);
  assert.match(conf, /server=1\.1\.1\.1/);
  assert.match(conf, /server=8\.8\.8\.8/);
  assert.doesNotMatch(conf, /server=127\.0\.0\.11/);
});

test('renderEgressApiJs: is the bundled src/egress/server.ts, self-contained on node built-ins', () => {
  const api = renderEgressApiJs();
  assert.match(api, /^\/\/ src\/egress\/server\.ts/);
  const imports = [
    ...api.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gm),
  ].map(m => m[1]);
  assert.ok(imports.length > 0, 'bundle keeps its node: imports');
  for (const spec of imports) {
    assert.ok(
      spec.startsWith('node:'),
      `non-builtin import in bundle: ${spec}`
    );
  }
  // No bundler-wrapped CommonJS require() shims (the container has no node_modules).
  assert.doesNotMatch(api, /__require\(|createRequire\(/);
});

test('renderEgressApiJs: bakes in the shared container-side port and mount paths', () => {
  const api = renderEgressApiJs();
  assert.ok(api.includes(String(EGRESS_API_PORT)));
  assert.ok(api.includes(EGRESS_BLACKLIST_MOUNT));
  assert.ok(api.includes('/var/log/egress'));
});

test('renderEgressApiJs: parses as an ES module under the node the image ships', () => {
  withTempFile('egress-api.mjs', renderEgressApiJs(), file => {
    execFileSync(process.execPath, ['--check', file]);
  });
});

test('renderBlacklistExample: documents the dnsmasq address= directive for both address families, not a bare domain', () => {
  const example = renderBlacklistExample();
  assert.match(example, /address=\/example\.com\/0\.0\.0\.0/);
  assert.match(example, /address=\/example\.com\/::/);
  assert.doesNotMatch(example, /^example\.com\s*$/m);
});

test('renderEgressFiles: renders exactly the five build-context files', () => {
  const files = renderEgressFiles();
  assert.deepEqual(
    Object.keys(files).sort(),
    Object.values(EGRESS_FILES).sort()
  );
  assert.equal(files[EGRESS_FILES.apiScript], renderEgressApiJs());
});
