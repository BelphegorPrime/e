import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createBrokerApi } from './broker/server/api.js';
import { createEgressApi } from './egress/server/api.js';
import { MAX_BODY_BYTES, type SidecarHandler } from './http.js';

/**
 * Every sidecar that takes a POST, and the route that takes it. The list is
 * the point: an oversized body used to be answered by the broker's error tail
 * but by one egress *route*, leaving egress's own tail with no 413 at all - so
 * the pin below is written over every sidecar at once rather than once per
 * sidecar, where the two could drift apart again unnoticed.
 */
const SIDECARS: {
  name: string;
  postPath: string;
  build: (dir: string) => SidecarHandler;
}[] = [
  {
    name: 'broker',
    postPath: '/spawn',
    build: dir => createBrokerApi({ spoolDir: dir }),
  },
  {
    name: 'egress',
    postPath: '/blacklist/domains',
    build: dir =>
      createEgressApi({
        logFile: path.join(dir, 'dnsmasq.log'),
        blacklistFile: path.join(dir, 'dnsmasq.blacklist'),
        reload: () => {},
      }),
  },
];

/** A body every sidecar's POST route would otherwise accept, only far too big. */
const OVERSIZED = JSON.stringify({
  agent: 'a',
  prompt: 'x'.repeat(MAX_BODY_BYTES),
  domain: 'x'.repeat(MAX_BODY_BYTES),
});

test('sidecar http: an oversized body is the same 413 from every sidecar', async () => {
  const answers: string[] = [];
  for (const sidecar of SIDECARS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-sidecar-http-'));
    const server = http.createServer(sidecar.build(dir));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
      const res = await fetch(
        `http://127.0.0.1:${address.port}${sidecar.postPath}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: OVERSIZED,
        }
      );
      assert.equal(res.status, 413, sidecar.name);
      assert.equal(res.headers.get('content-type'), 'application/json');
      answers.push(`${res.status} ${await res.text()}`);
      // The refusal happens before any route work, so nothing was spooled,
      // blacklisted or otherwise written.
      assert.deepEqual(fs.readdirSync(dir), [], sidecar.name);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Not merely "413 each": byte for byte the same refusal, so no reader can
  // tell the sidecars apart by how they turn a client down.
  assert.equal(answers.length, SIDECARS.length);
  assert.deepEqual(new Set(answers), new Set([answers[0]]));
  assert.equal(answers[0], '413 {"error":"Request body too large"}');
});
