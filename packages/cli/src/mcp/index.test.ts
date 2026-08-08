import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMcpServer,
  sidecarImageTag,
  sidecarNetworkName,
  sidecarContainerName,
  mcpEndpoint,
  renderEverythingFiles,
  renderFilesystemFiles,
  type McpServer,
} from './index';

test('parseMcpServer accepts a minimal container server', () => {
  const server = parseMcpServer(
    { transport: 'container', port: 3001 },
    'everything',
    'mcp.json',
  );
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
  );
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

test('parseMcpServer rejects a non-container transport (only container today)', () => {
  assert.throws(
    () => parseMcpServer({ transport: 'remote', port: 3001 }, 'x', 'mcp.json'),
    /transport/,
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

test('sidecarImageTag namespaces under e-mcp-', () => {
  assert.equal(sidecarImageTag('everything'), 'e-mcp-everything');
});

test('sidecar network and container names are derived from the run name', () => {
  assert.equal(sidecarNetworkName('e-demo-fix-1'), 'e-demo-fix-1-net');
  assert.equal(
    sidecarContainerName('e-demo-fix-1', 'everything'),
    'e-demo-fix-1-mcp-everything',
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

test('shipped everything server is credential-free streamable HTTP on 3001', () => {
  const files = renderEverythingFiles();
  const parsed = parseMcpServer(JSON.parse(files['mcp.json']), 'everything', 'mcp.json');
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
