import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderEgressDockerfile,
  renderEgressEntrypoint,
  renderDnsmasqBaseConf,
  renderEgressFiles,
} from './renderEgress.js';

test('renderEgressDockerfile: alpine base with dnsmasq + iptables, entrypoint set', () => {
  const df = renderEgressDockerfile();
  assert.match(df, /FROM alpine:/);
  assert.match(df, /apk add --no-cache dnsmasq iptables/);
  assert.match(df, /ENTRYPOINT \["\/egress-entrypoint.sh"\]/);
  assert.doesNotMatch(df, /VOLUME.*\/etc\/egress\.d/);
});

test('renderEgressEntrypoint: wires the mounted iptables script into an EGRESS chain', () => {
  const ep = renderEgressEntrypoint();
  assert.match(ep, /iptables -N EGRESS/);
  assert.match(ep, /iptables -I OUTPUT -j EGRESS/);
  assert.match(ep, /\/etc\/egress\.d\/iptables\.rules/);
  assert.match(ep, /exec dnsmasq -k -d/);
  assert.match(ep, /\/var\/log\/egress\/dnsmasq\.log/);
});

test('renderDnsmasqBaseConf: binds loopback and avoids an embedded-DNS forwarding loop', () => {
  const conf = renderDnsmasqBaseConf();
  assert.match(conf, /bind-interfaces/);
  assert.match(conf, /listen-address=127\.0\.0\.1/);
  assert.match(conf, /server=1\.1\.1\.1/);
  assert.match(conf, /server=8\.8\.8\.8/);
  assert.doesNotMatch(conf, /server=127\.0\.0\.11/);
});

test('renderEgressFiles: renders exactly the four build-context files', () => {
  const files = renderEgressFiles();
  assert.deepEqual(Object.keys(files).sort(), [
    'Dockerfile',
    'blacklist.example',
    'dnsmasq.conf',
    'entrypoint.sh',
  ]);
});