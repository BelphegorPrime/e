import assert from 'node:assert/strict';
import express from 'express';
import http, { type Server } from 'node:http';
import { test } from 'node:test';

import { respondNotFound } from './apiResponse.js';
import {
  egressRoutes,
  omniRouteEmbedPortFor,
  startOmniRouteEmbedProxy,
} from './reverseProxy.js';

/** What one upstream request looked like from the other side of the proxy. */
interface SeenRequest {
  url: string;
  method: string;
  body: string;
}

function listen(server: Server): Promise<number> {
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      resolve(address.port);
    })
  );
}

function close(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

/**
 * A stand-in egress API behind the proxy, wired the way `createServeApp` wires
 * it: the egress routes first, the JSON body parser after, so the test also
 * covers the ordering the streaming proxy depends on.
 */
async function withEgress(
  fn: (baseUrl: string, seen: SeenRequest[]) => Promise<void>,
  options: { upstreamUrl?: string } = {}
): Promise<void> {
  const seen: SeenRequest[] = [];
  const upstream = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      seen.push({ url: request.url ?? '', method: request.method ?? '', body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
    });
  });
  const upstreamPort = await listen(upstream);
  const app = express();
  app.use(
    egressRoutes(options.upstreamUrl ?? `http://127.0.0.1:${upstreamPort}`)
  );
  app.use('/api', express.json());
  app.use('/api', (_request, response) => respondNotFound(response));
  const bff = http.createServer(app);
  const bffPort = await listen(bff);
  try {
    await fn(`http://127.0.0.1:${bffPort}`, seen);
  } finally {
    await close(bff);
    await close(upstream);
  }
}

test('the egress proxy forwards the path without a double slash', async () => {
  await withEgress(async (baseUrl, seen) => {
    const res = await fetch(`${baseUrl}/api/egress/logs`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
    assert.equal(seen[0]?.url, '/logs');
  });
});

test('the egress proxy forwards the query string (the /logs filters live there)', async () => {
  await withEgress(async (baseUrl, seen) => {
    const res = await fetch(
      `${baseUrl}/api/egress/logs?limit=10&action=deny(sinkholed)`
    );
    assert.equal(res.status, 200);
    assert.equal(seen[0]?.url, '/logs?limit=10&action=deny(sinkholed)');
    // A bare prefix (with or without a query) is not a proxied route.
    assert.equal((await fetch(`${baseUrl}/api/egress/?x=1`)).status, 404);
    assert.equal(seen.length, 1, 'the bare prefix never reached the upstream');
  });
});

test('the egress proxy streams the request body through, JSON parser or not', async () => {
  await withEgress(async (baseUrl, seen) => {
    const res = await fetch(`${baseUrl}/api/egress/blacklist/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'golem.de' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
    assert.deepEqual(seen[0], {
      url: '/blacklist/domains',
      method: 'POST',
      body: JSON.stringify({ domain: 'golem.de' }),
    });
  });
});

test('an unreachable egress API is a 502 the page can read as JSON', async () => {
  // Port 1 on loopback: nothing listens, so the proxy fails to connect.
  await withEgress(
    async baseUrl => {
      const res = await fetch(`${baseUrl}/api/egress/logs`);
      assert.equal(res.status, 502);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /^Egress API error: /);
    },
    { upstreamUrl: 'http://127.0.0.1:1' }
  );
});

test('without an egress API URL the routes exist but answer 503', async () => {
  await withEgress(
    async baseUrl => {
      const res = await fetch(`${baseUrl}/api/egress/logs`);
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), {
        error: 'Egress API not configured',
      });
    },
    { upstreamUrl: '' }
  );
});

test('OmniRoute embed proxy mirrors paths 1:1, strips framing headers and keeps session cookies scoped to its origin', async () => {
  const seen: { url?: string; body?: string } = {};
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      seen.url = req.url;
      seen.body = body;
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-security-policy': "frame-ancestors 'none'",
        'x-frame-options': 'DENY',
        'set-cookie':
          'auth_token=abc; Path=/; Domain=omniroute.local; Secure; HttpOnly',
      });
      res.end('{"ok":true}');
    });
  });
  const upstreamPort = await listen(upstream);
  const proxy = await startOmniRouteEmbedProxy(
    '127.0.0.1',
    0,
    `http://127.0.0.1:${upstreamPort}`
  );
  const address = proxy.address();
  assert.ok(address && typeof address !== 'string');
  try {
    // OmniRoute's login endpoint is root-anchored, not under /dashboard.
    const res = await fetch(`http://127.0.0.1:${address.port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'pw' }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen.url, '/api/auth/login');
    assert.equal(seen.body, '{"password":"pw"}');
    assert.equal(res.headers.get('content-security-policy'), null);
    assert.equal(res.headers.get('x-frame-options'), null);
    assert.equal(
      res.headers.get('set-cookie'),
      'auth_token=abc; Path=/; HttpOnly'
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('the embed proxy port sits right next to the BFF port', () => {
  assert.equal(omniRouteEmbedPortFor(8080), 8081);
});
