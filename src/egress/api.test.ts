import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createEgressApi } from './api.js';
import type { BlacklistDomainsResponse, SquashedEntry } from './types.js';

interface Fixture {
  url: string;
  logFile: string;
  blacklistFile: string;
  reloads: number;
  close(): Promise<void>;
}

async function startApi(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-egress-api-'));
  const logFile = path.join(dir, 'dnsmasq.log');
  const blacklistFile = path.join(dir, 'dnsmasq.blacklist');
  const fixture: Fixture = {
    url: '',
    logFile,
    blacklistFile,
    reloads: 0,
    close: async () => {},
  };
  const server = http.createServer(
    createEgressApi({
      logFile,
      blacklistFile,
      reload: () => {
        fixture.reloads++;
      },
    })
  );
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  fixture.url = `http://127.0.0.1:${address.port}`;
  fixture.close = async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return fixture;
}

async function json<T>(res: Response): Promise<T> {
  assert.equal(res.headers.get('content-type'), 'application/json');
  return (await res.json()) as T;
}

test('egress api: GET /health', async () => {
  const api = await startApi();
  try {
    const res = await fetch(`${api.url}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { status: 'ok' });
  } finally {
    await api.close();
  }
});

test('egress api: GET /logs classifies against the blacklist; missing files read as empty', async () => {
  const api = await startApi();
  try {
    const empty = await fetch(`${api.url}/logs`);
    assert.deepEqual(await json(empty), []);

    fs.writeFileSync(api.blacklistFile, 'address=/blocked.example/0.0.0.0\n');
    fs.writeFileSync(
      api.logFile,
      [
        'Sep  7 15:00:01 dnsmasq[1]: query[A] ok.example from 127.0.0.1',
        'Sep  7 15:00:02 dnsmasq[1]: query[A] cdn.blocked.example from 127.0.0.1',
        '',
      ].join('\n')
    );
    const res = await fetch(`${api.url}/logs?action=deny(sinkholed)`);
    const entries = await json<Array<{ domain: string; action: string }>>(res);
    assert.deepEqual(
      entries.map(e => [e.domain, e.action]),
      [['cdn.blocked.example', 'deny(sinkholed)']]
    );
  } finally {
    await api.close();
  }
});

test('egress api: GET /logs/squashed rolls up per domain', async () => {
  const api = await startApi();
  try {
    fs.writeFileSync(
      api.logFile,
      [
        'Sep  7 15:00:01 dnsmasq[1]: query[A] a.example from 127.0.0.1',
        'Sep  7 15:00:02 dnsmasq[1]: reply a.example is 1.2.3.4',
        'Sep  7 15:00:03 dnsmasq[1]: query[A] localhost from 127.0.0.1',
        '',
      ].join('\n')
    );
    const res = await fetch(`${api.url}/logs/squashed`);
    const rows = await json<SquashedEntry[]>(res);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].domain, 'a.example');
    assert.equal(rows[0].count, 2);
  } finally {
    await api.close();
  }
});

test('egress api: blacklist GET/POST/DELETE write dnsmasq address= directives and trigger a reload', async () => {
  const api = await startApi();
  try {
    const listEmpty = await fetch(`${api.url}/blacklist/domains`);
    assert.deepEqual(await json<BlacklistDomainsResponse>(listEmpty), {
      domains: [],
    });

    const post = await fetch(`${api.url}/blacklist/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'Example.COM.' }),
    });
    assert.equal(post.status, 200);
    assert.deepEqual(await json(post), { status: 'ok' });
    assert.equal(
      fs.readFileSync(api.blacklistFile, 'utf-8'),
      'address=/example.com/0.0.0.0\naddress=/example.com/::\n'
    );
    assert.equal(api.reloads, 1);

    const list = await fetch(`${api.url}/blacklist/domains`);
    assert.deepEqual(await json(list), { domains: ['example.com'] });

    const del = await fetch(
      `${api.url}/blacklist/domains/${encodeURIComponent('example.com')}`,
      { method: 'DELETE' }
    );
    assert.equal(del.status, 200);
    assert.equal(fs.readFileSync(api.blacklistFile, 'utf-8'), '');
    assert.equal(api.reloads, 2);
  } finally {
    await api.close();
  }
});

test('egress api: POST rejects a missing domain and malformed JSON with 400', async () => {
  const api = await startApi();
  try {
    const missing = await fetch(`${api.url}/blacklist/domains`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);
    assert.deepEqual(await json(missing), { error: 'Missing domain' });

    const malformed = await fetch(`${api.url}/blacklist/domains`, {
      method: 'POST',
      body: '{not json',
    });
    assert.equal(malformed.status, 400);
    assert.equal(api.reloads, 0);
  } finally {
    await api.close();
  }
});

test('egress api: unknown routes and wrong methods are 404', async () => {
  const api = await startApi();
  try {
    assert.equal((await fetch(`${api.url}/nope`)).status, 404);
    assert.equal(
      (await fetch(`${api.url}/logs`, { method: 'POST' })).status,
      404
    );
  } finally {
    await api.close();
  }
});
