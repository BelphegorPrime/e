import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EGRESS_FILES, renderEgressFiles } from './render.js';
import {
  EGRESS_API_PORT,
  EGRESS_BLACKLIST_IP_MOUNT,
  EGRESS_BLACKLIST_MOUNT,
  EGRESS_DNSMASQ_LOG,
} from './contract/constants.js';

/** One rendered build context, the only thing the module hands out. */
const files = (): Record<string, string> => renderEgressFiles();

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

test('renderEgressFiles: renders exactly the six build-context files, none of them empty', () => {
  const rendered = files();
  assert.deepEqual(
    Object.keys(rendered).sort(),
    Object.values(EGRESS_FILES).sort()
  );
  for (const [name, content] of Object.entries(rendered)) {
    assert.ok(content.length > 0, `${name} rendered empty`);
  }
});

test('Dockerfile: node/alpine base with dnsmasq + iptables, copies every rendered file it needs, entrypoint set', () => {
  const df = files()[EGRESS_FILES.dockerfile];
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

test('entrypoint.sh: wires the mounted iptables script into an EGRESS chain and logs to the shared log path', () => {
  const ep = files()[EGRESS_FILES.entrypoint];
  assert.match(ep, /iptables -N EGRESS/);
  assert.match(ep, /iptables -I OUTPUT -j EGRESS/);
  assert.ok(ep.includes(`IP_BLACKLIST="${EGRESS_BLACKLIST_IP_MOUNT}"`));
  assert.match(ep, /dnsmasq -k -d/);
  assert.ok(ep.includes(`--log-facility="${EGRESS_DNSMASQ_LOG}"`));
  assert.match(ep, /node \/egress-api\.mjs &/);
});

test('entrypoint.sh: stays PID 1 and restarts dnsmasq on SIGHUP instead of exec-ing into it (dnsmasq SIGHUP never re-reads --conf-dir)', () => {
  const ep = files()[EGRESS_FILES.entrypoint];
  assert.doesNotMatch(ep, /\bexec dnsmasq\b/);
  assert.match(ep, /trap 'restart_dnsmasq' HUP/);
  assert.match(ep, /DNSMASQ_PID=\$!/);
  assert.match(
    ep,
    /restart_dnsmasq\(\) \{[\s\S]*apply_ip_rules[\s\S]*kill "\$\{DNSMASQ_PID\}"[\s\S]*while kill -0 "\$\{DNSMASQ_PID\}"[\s\S]*start_dnsmasq/
  );
  assert.match(ep, /trap 'kill "\$\{DNSMASQ_PID\}".*TERM INT/);
});

test('entrypoint.sh: is valid POSIX shell (both host sh and busybox)', () => {
  withTempFile('entrypoint.sh', files()[EGRESS_FILES.entrypoint], file => {
    execFileSync('sh', ['-n', file]);
  });
});

test('dnsmasq.conf: binds loopback and avoids an embedded-DNS forwarding loop', () => {
  const conf = files()[EGRESS_FILES.dnsmasqConf];
  assert.match(conf, /bind-interfaces/);
  assert.match(conf, /listen-address=127\.0\.0\.1/);
  assert.match(conf, /server=1\.1\.1\.1/);
  assert.match(conf, /server=8\.8\.8\.8/);
  assert.doesNotMatch(conf, /server=127\.0\.0\.11/);
});

test('egress-api.mjs: is the bundled src/sidecars/egress/server/api.ts, self-contained on node built-ins', () => {
  const api = files()[EGRESS_FILES.apiScript];
  assert.match(api, /^\/\/ src\/sidecars\/egress\/server\/api\.ts/);
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

test('egress-api.mjs: bakes in the shared container-side port and mount paths, and listens when run as the entry', () => {
  const api = files()[EGRESS_FILES.apiScript];
  assert.ok(api.includes(String(EGRESS_API_PORT)));
  assert.ok(api.includes(EGRESS_BLACKLIST_MOUNT));
  assert.ok(api.includes('/var/log/egress'));
  // The bundle is the container's entry, so the guarded listen has to survive
  // bundling: without it the entrypoint starts a process that serves nothing.
  assert.match(
    api,
    /if \(import\.meta\.main\) \{[\s\S]*createServer\(createEgressApi\(\)\)\.listen\(/
  );
});

test('egress-api.mjs: parses as an ES module under the node the image ships', () => {
  withTempFile('egress-api.mjs', files()[EGRESS_FILES.apiScript], file => {
    execFileSync(process.execPath, ['--check', file]);
  });
});

test('blacklist.example: documents the dnsmasq address= directive for both address families, not a bare domain', () => {
  const example = files()[EGRESS_FILES.blacklistExample];
  assert.match(example, /address=\/example\.com\/0\.0\.0\.0/);
  assert.match(example, /address=\/example\.com\/::/);
  assert.doesNotMatch(example, /^example\.com\s*$/m);
});

test('iptables.example: a comment-only sh script that documents EGRESS-chain rules for both families', () => {
  const example = files()[EGRESS_FILES.iptablesExample];
  assert.match(example, /iptables -A EGRESS .* -j REJECT/);
  assert.match(example, /ip6tables -A EGRESS/);
  assert.match(example, /docker kill -s HUP e-egress/);
  // Applied with `sh` by the entrypoint on every start: must parse and do nothing.
  assert.ok(example.split('\n').every(l => l === '' || l.startsWith('#')));
  withTempFile('iptables.rules', example, file => {
    execFileSync('sh', ['-n', file]);
  });
});
