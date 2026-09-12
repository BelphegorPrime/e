import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BROKER_FILES, renderBrokerFiles } from './renderBroker.js';
import { BROKER_PORT, BROKER_SPOOL_MOUNT } from '../broker/constants.js';

test('renderBrokerFiles: a Dockerfile and the bundled server, nothing else', () => {
  const files = renderBrokerFiles();
  assert.deepEqual(Object.keys(files).sort(), ['Dockerfile', 'broker.mjs']);
  assert.ok(files[BROKER_FILES.serverScript].length > 0);
});

test('renderBrokerFiles: the image listens on the broker port, mounts no socket, runs as root like egress', () => {
  const dockerfile = renderBrokerFiles()[BROKER_FILES.dockerfile];
  assert.match(dockerfile, /^FROM node:24-alpine$/m);
  // Root on purpose: the spool is a host-owned bind mount (see renderBroker.ts).
  assert.doesNotMatch(dockerfile, /^USER /m);
  assert.match(dockerfile, new RegExp(`^EXPOSE ${BROKER_PORT}$`, 'm'));
  assert.match(dockerfile, /^COPY broker\.mjs \/broker\.mjs$/m);
  assert.match(dockerfile, new RegExp(`RUN mkdir -p ${BROKER_SPOOL_MOUNT}`));
  // The ADR-0002 line: no runtime socket, no declared volume, no credentials.
  assert.doesNotMatch(dockerfile, /docker\.sock|VOLUME|ENV .*(TOKEN|KEY)/);
});

test('renderBrokerFiles: the server bundle is dependency-free and uses the spool mount', () => {
  const server = renderBrokerFiles()[BROKER_FILES.serverScript];
  const imports = [...server.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gm)]
    .map(m => m[1])
    .filter(spec => !spec.startsWith('node:'));
  assert.deepEqual(imports, []);
  assert.match(server, new RegExp(BROKER_SPOOL_MOUNT.replace(/\//g, '\\/')));
  assert.match(server, new RegExp(String(BROKER_PORT)));
});

function withTempFile(
  name: string,
  content: string,
  fn: (file: string) => void
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-render-broker-'));
  try {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('renderBrokerFiles: the server bundle parses as an ES module and carries no CommonJS shim', () => {
  const server = renderBrokerFiles()[BROKER_FILES.serverScript];
  // No bundler-wrapped require() shims (the container has no node_modules).
  assert.doesNotMatch(server, /__require\(|createRequire\(/);
  withTempFile('broker.mjs', server, file => {
    execFileSync(process.execPath, ['--check', file]);
  });
});
