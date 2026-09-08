import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseMcpServer,
  mcpEndpoint,
  readMcpServer,
  listMcpServerNames,
  allocateMcpPorts,
  planMcpSelection,
  renderEverythingFiles,
  renderFilesystemFiles,
  renderSearxngFiles,
  type McpServer,
  type ContainerMcpServer,
  type RemoteMcpServer,
} from './index.js';

test('parseMcpServer accepts a minimal container server', () => {
  const server = parseMcpServer(
    { transport: 'container', port: 3001 },
    'everything',
    'mcp.json'
  ) as ContainerMcpServer;
  assert.equal(server.name, 'everything');
  assert.equal(server.transport, 'container');
  assert.equal(server.port, 3001);
  assert.deepEqual(server.requiredEnv, []);
  assert.equal(server.healthcheck, undefined);
});

test('parseMcpServer keeps requiredEnv and an optional healthcheck', () => {
  const server = parseMcpServer(
    {
      transport: 'container',
      port: 8000,
      requiredEnv: ['GITHUB_TOKEN'],
      healthcheck: ['node', '-e', 'process.exit(0)'],
    },
    'gh',
    'mcp.json'
  ) as ContainerMcpServer;
  assert.deepEqual(server.requiredEnv, ['GITHUB_TOKEN']);
  assert.deepEqual(server.healthcheck, ['node', '-e', 'process.exit(0)']);
});

test('parseMcpServer rejects a missing or non-numeric port', () => {
  assert.throws(
    () => parseMcpServer({ transport: 'container' }, 'x', 'mcp.json'),
    /port/
  );
  assert.throws(
    () =>
      parseMcpServer({ transport: 'container', port: 'nope' }, 'x', 'mcp.json'),
    /port/
  );
});

test('parseMcpServer rejects an unknown transport', () => {
  assert.throws(
    () => parseMcpServer({ transport: 'stdio', port: 3001 }, 'x', 'mcp.json'),
    /transport must be "container" or "remote"/
  );
});

test('parseMcpServer accepts a remote server with url + optional headers', () => {
  const server = parseMcpServer(
    {
      transport: 'remote',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer ${EXAMPLE_TOKEN}' },
      requiredEnv: ['EXAMPLE_TOKEN'],
    },
    'example',
    'mcp.json'
  ) as RemoteMcpServer;
  assert.equal(server.transport, 'remote');
  assert.equal(server.url, 'https://mcp.example.com/mcp');
  assert.deepEqual(server.headers, {
    Authorization: 'Bearer ${EXAMPLE_TOKEN}',
  });
  assert.deepEqual(server.requiredEnv, ['EXAMPLE_TOKEN']);
});

test('parseMcpServer rejects a remote server without a url', () => {
  assert.throws(
    () =>
      parseMcpServer({ transport: 'remote', requiredEnv: [] }, 'x', 'mcp.json'),
    /non-empty "url"/
  );
});

test('parseMcpServer rejects remote headers that are not string values', () => {
  assert.throws(
    () =>
      parseMcpServer(
        { transport: 'remote', url: 'https://x/mcp', headers: { A: 1 } },
        'x',
        'mcp.json'
      ),
    /headers/
  );
});

test('parseMcpServer rejects a non-string-array requiredEnv or healthcheck', () => {
  assert.throws(
    () =>
      parseMcpServer(
        { transport: 'container', port: 1, requiredEnv: 'GITHUB_TOKEN' },
        'x',
        'mcp.json'
      ),
    /requiredEnv/
  );
  assert.throws(
    () =>
      parseMcpServer(
        { transport: 'container', port: 1, healthcheck: 'true' },
        'x',
        'mcp.json'
      ),
    /healthcheck/
  );
});

test('mcpEndpoint wires the alias short name and the /mcp path', () => {
  const server: McpServer = {
    name: 'everything',
    transport: 'container',
    port: 3001,
    requiredEnv: [],
  };
  assert.deepEqual(mcpEndpoint(server), {
    name: 'everything',
    url: 'http://everything:3001/mcp',
  });
});

test('mcpEndpoint of a remote server is its declared url and headers, not a sidecar alias', () => {
  const server: RemoteMcpServer = {
    name: 'hosted',
    transport: 'remote',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer ${TOKEN}' },
    requiredEnv: ['TOKEN'],
  };
  assert.deepEqual(mcpEndpoint(server), {
    name: 'hosted',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer ${TOKEN}' },
  });
});

test('planMcpSelection splits transports (mixed) and keeps every endpoint in order', () => {
  const remote: RemoteMcpServer = {
    name: 'hosted',
    transport: 'remote',
    url: 'https://mcp.example.com/mcp',
    requiredEnv: [],
  };
  const container: ContainerMcpServer = {
    name: 'everything',
    transport: 'container',
    port: 3001,
    requiredEnv: [],
  };
  const plan = planMcpSelection([remote, container]);

  // Only the container server becomes a sidecar; the remote one does not.
  assert.deepEqual(
    plan.containerServers.map(s => s.name),
    ['everything']
  );
  assert.deepEqual(
    plan.remoteServers.map(s => s.name),
    ['hosted']
  );
  // Both are wired as endpoints, in selection order.
  assert.deepEqual(
    plan.endpoints.map(e => e.name),
    ['hosted', 'everything']
  );
  assert.equal(plan.endpoints[0].url, 'https://mcp.example.com/mcp');
  assert.equal(plan.endpoints[1].url, 'http://everything:3001/mcp');
});

test('shipped everything server is credential-free streamable HTTP on 3001', () => {
  const files = renderEverythingFiles();
  const parsed = parseMcpServer(
    JSON.parse(files['mcp.json']),
    'everything',
    'mcp.json'
  ) as ContainerMcpServer;
  assert.equal(parsed.port, 3001);
  assert.deepEqual(parsed.requiredEnv, []);
  assert.match(files['Dockerfile'], /streamableHttp/);
});

test('shipped filesystem server bridges stdio to streamable HTTP', () => {
  const files = renderFilesystemFiles();
  const parsed = parseMcpServer(
    JSON.parse(files['mcp.json']),
    'filesystem',
    'mcp.json'
  );
  assert.equal(parsed.transport, 'container');
  assert.match(files['Dockerfile'], /supergateway/);
});

test('shipped searxng server proxies web_search and fetch_content to Searxng', () => {
  const files = renderSearxngFiles();
  const parsed = parseMcpServer(
    JSON.parse(files['mcp.json']),
    'searxng',
    'mcp.json'
  ) as ContainerMcpServer;
  assert.equal(parsed.port, 3000);
  assert.deepEqual(parsed.requiredEnv, []);
  assert.match(files['Dockerfile'], /supergateway/);
  assert.match(files['Dockerfile'], /mcp-server\.mjs/);
});
test('readMcpServer returns undefined for a name that was never persisted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-mcp-'));
  try {
    assert.equal(readMcpServer('ghost', root), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readMcpServer round-trips a persisted mcp.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-mcp-'));
  try {
    const dir = path.join(root, '.e', 'mcp', 'everything');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'mcp.json'),
      JSON.stringify({
        transport: 'container',
        port: 3001,
        requiredEnv: [],
      })
    );
    const server = readMcpServer('everything', root);
    assert.equal(server?.name, 'everything');
    assert.equal(server?.transport, 'container');
    assert.equal(server?.port, 3001);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listMcpServerNames lists persisted server dirs only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-mcp-'));
  try {
    assert.deepEqual(listMcpServerNames(root), []);
    fs.mkdirSync(path.join(root, '.e', 'mcp', 'everything'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(root, '.e', 'mcp', 'filesystem'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, '.e', 'mcp', 'not-a-dir'), 'x');
    assert.deepEqual(
      [...listMcpServerNames(root)].sort(),
      ['everything', 'filesystem']
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('allocateMcpPorts keeps declared ports when they are free', () => {
  const servers = [
    { name: 'a', port: 3001 },
    { name: 'b', port: 3002 },
  ] as ContainerMcpServer[];
  assert.deepEqual([...allocateMcpPorts(servers)], [
    ['a', 3001],
    ['b', 3002],
  ]);
});

test('allocateMcpPorts moves a colliding port into the dynamic range', () => {
  const servers = [{ name: 'a', port: 3001 }] as ContainerMcpServer[];
  const result = allocateMcpPorts(servers, [3001]);
  assert.equal(result.get('a'), 31000);
});

test('allocateMcpPorts advances past occupied dynamic ports and stays unique', () => {
  const servers = [
    { name: 'a', port: 3001, }, // collides -> 31000
    { name: 'b', port: 31000 + 1 }, // free
  ] as ContainerMcpServer[];
  const result = allocateMcpPorts(servers, [3001, 31000]);
  assert.equal(result.get('a'), 31001);
  assert.equal(result.get('b'), 31002);
});

test('allocateMcpPorts throws when the dynamic range is exhausted', () => {
  const servers = [
    { name: 'a', port: 3001 },
    { name: 'b', port: 3002 },
  ] as ContainerMcpServer[];
  const occupied = new Set<number>([3001, 3002]);
  for (let p = 31000; p <= 31999; p++) occupied.add(p);
  assert.throws(
    () => allocateMcpPorts(servers, occupied),
    /No free MCP ports/
  );
});
