import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMcpServer,
  mcpEndpoint,
  planMcpSelection,
  renderEverythingFiles,
  renderFilesystemFiles,
  type McpServer,
  type ContainerMcpServer,
  type RemoteMcpServer,
} from './index';

test('parseMcpServer accepts a minimal container server', () => {
  const server = parseMcpServer(
    { transport: 'container', port: 3001 },
    'everything',
    'mcp.json',
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
    'mcp.json',
  ) as ContainerMcpServer;
  assert.deepEqual(server.requiredEnv, ['GITHUB_TOKEN']);
  assert.deepEqual(server.healthcheck, ['node', '-e', 'process.exit(0)']);
});

test('parseMcpServer rejects a missing or non-numeric port', () => {
  assert.throws(
    () => parseMcpServer({ transport: 'container' }, 'x', 'mcp.json'),
    /port/,
  );
  assert.throws(
    () => parseMcpServer({ transport: 'container', port: 'nope' }, 'x', 'mcp.json'),
    /port/,
  );
});

test('parseMcpServer rejects an unknown transport', () => {
  assert.throws(
    () => parseMcpServer({ transport: 'stdio', port: 3001 }, 'x', 'mcp.json'),
    /transport must be "container" or "remote"/,
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
    'mcp.json',
  ) as RemoteMcpServer;
  assert.equal(server.transport, 'remote');
  assert.equal(server.url, 'https://mcp.example.com/mcp');
  assert.deepEqual(server.headers, { Authorization: 'Bearer ${EXAMPLE_TOKEN}' });
  assert.deepEqual(server.requiredEnv, ['EXAMPLE_TOKEN']);
});

test('parseMcpServer rejects a remote server without a url', () => {
  assert.throws(
    () => parseMcpServer({ transport: 'remote', requiredEnv: [] }, 'x', 'mcp.json'),
    /non-empty "url"/,
  );
});

test('parseMcpServer rejects remote headers that are not string values', () => {
  assert.throws(
    () =>
      parseMcpServer(
        { transport: 'remote', url: 'https://x/mcp', headers: { A: 1 } },
        'x',
        'mcp.json',
      ),
    /headers/,
  );
});

test('parseMcpServer rejects a non-string-array requiredEnv or healthcheck', () => {
  assert.throws(
    () =>
      parseMcpServer(
        { transport: 'container', port: 1, requiredEnv: 'GITHUB_TOKEN' },
        'x',
        'mcp.json',
      ),
    /requiredEnv/,
  );
  assert.throws(
    () =>
      parseMcpServer(
        { transport: 'container', port: 1, healthcheck: 'true' },
        'x',
        'mcp.json',
      ),
    /healthcheck/,
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
  assert.deepEqual(plan.containerServers.map((s) => s.name), ['everything']);
  assert.deepEqual(plan.remoteServers.map((s) => s.name), ['hosted']);
  // Both are wired as endpoints, in selection order.
  assert.deepEqual(plan.endpoints.map((e) => e.name), ['hosted', 'everything']);
  assert.equal(plan.endpoints[0].url, 'https://mcp.example.com/mcp');
  assert.equal(plan.endpoints[1].url, 'http://everything:3001/mcp');
});

test('shipped everything server is credential-free streamable HTTP on 3001', () => {
  const files = renderEverythingFiles();
  const parsed = parseMcpServer(
    JSON.parse(files['mcp.json']),
    'everything',
    'mcp.json',
  ) as ContainerMcpServer;
  assert.equal(parsed.port, 3001);
  assert.deepEqual(parsed.requiredEnv, []);
  assert.match(files['Dockerfile'], /streamableHttp/);
});

test('shipped filesystem server bridges stdio to streamable HTTP', () => {
  const files = renderFilesystemFiles();
  const parsed = parseMcpServer(JSON.parse(files['mcp.json']), 'filesystem', 'mcp.json');
  assert.equal(parsed.transport, 'container');
  assert.match(files['Dockerfile'], /supergateway/);
});
