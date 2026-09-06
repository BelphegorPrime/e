import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEndpointUrl,
  providerBaseUrl,
  deriveEgressAllowList,
  planEgressProxies,
  renderEgressDockerfile,
  EGRESS_IMAGE_TAG,
  LOCAL_STACK_HOST,
  EGRESS_HOST_ENV,
  EGRESS_PORTS_ENV,
} from './index.js';

test('parseEndpointUrl: explicit port, scheme default ports', () => {
  assert.deepEqual(parseEndpointUrl('https://gateway.example.com:443/v1'), {
    host: 'gateway.example.com',
    port: 443,
  });
  assert.deepEqual(parseEndpointUrl('https://gateway.example.com/v1'), {
    host: 'gateway.example.com',
    port: 443,
  });
  assert.deepEqual(parseEndpointUrl('http://host.example.com:1234/path'), {
    host: 'host.example.com',
    port: 1234,
  });
  assert.deepEqual(parseEndpointUrl('http://host.example.com/path'), {
    host: 'host.example.com',
    port: 80,
  });
});

test('parseEndpointUrl: rejects a non-http URL', () => {
  assert.throws(() => parseEndpointUrl('file:///etc/passwd'), /only http\/https/);
});

test('providerBaseUrl: uses baseUrlEnv from the store when declared and set', () => {
  const provider = {
    baseUrl: 'http://host.docker.internal:20128',
    baseUrlEnv: 'MY_BASE_URL',
    model: 'auto',
    protocol: 'openai-responses' as const,
    apiKeyEnv: 'OPENAI_API_KEY',
  };
  assert.equal(
    providerBaseUrl(provider, {}),
    'http://host.docker.internal:20128'
  );
  assert.equal(
    providerBaseUrl(provider, { MY_BASE_URL: 'https://gateway.example.com' }),
    'https://gateway.example.com'
  );
});

test('deriveEgressAllowList: dedupes same host:port and sorts deterministically', () => {
  const list = deriveEgressAllowList([
    'https://b.example.com/v1',
    'https://a.example.com/mcp',
    'https://b.example.com/v1/models',
  ]);
  assert.deepEqual(
    list.map(e => `${e.host}:${e.port}`),
    ['a.example.com:443', 'b.example.com:443']
  );
});

test('planEgressProxies: groups ports by host, one proxy per host', () => {
  const plans = planEgressProxies(
    [
      { host: 'gateway.example.com', port: 443 },
      { host: 'mcp.example.com', port: 8000 },
      { host: 'gateway.example.com', port: 80 },
    ],
    { stackPresent: false, edgeNetwork: 'omniroute-edge' }
  );
  assert.deepEqual(
    plans.map(p => ({ alias: p.alias, ports: p.ports, wan: p.wan })),
    [
      { alias: 'gateway.example.com', ports: [80, 443], wan: 'bridge' },
      { alias: 'mcp.example.com', ports: [8000], wan: 'bridge' },
    ]
  );
  assert.equal(plans[0].upstreamHost, 'gateway.example.com');
  assert.equal(plans[0].extraHosts, undefined);
});

test('planEgressProxies: a stack-present host.docker.internal joins the edge network, no host-gateway', () => {
  const [plan] = planEgressProxies(
    [{ host: LOCAL_STACK_HOST, port: 20128 }],
    { stackPresent: true, edgeNetwork: 'omniroute-edge' }
  );
  assert.equal(plan.alias, LOCAL_STACK_HOST);
  assert.equal(plan.wan, 'omniroute-edge');
  assert.equal(plan.upstreamHost, LOCAL_STACK_HOST);
  assert.equal(plan.extraHosts, undefined);
});

test('planEgressProxies: a stack-less host.docker.internal keeps the host-gateway mapping', () => {
  const [plan] = planEgressProxies(
    [{ host: LOCAL_STACK_HOST, port: 20128 }],
    { stackPresent: false, edgeNetwork: 'omniroute-edge' }
  );
  assert.equal(plan.wan, 'bridge');
  assert.deepEqual(plan.extraHosts, ['host.docker.internal:host-gateway']);
});

test('renderEgressDockerfile: one socat per port, forwarding to the upstream host', () => {
  const df = renderEgressDockerfile();
  assert.match(df, /FROM alpine:3\.20/);
  assert.match(df, /socat/);
  // The CMD interpolates the env var names at runtime.
  assert.match(df, /\$EGRESS_PORTS/);
  assert.match(df, /\$EGRESS_HOST/);
  assert.match(df, /TCP-LISTEN:\$p,fork,reuseaddr/);
  assert.match(df, /TCP:\$EGRESS_HOST:\$p/);
});

test('egress constants', () => {
  assert.equal(EGRESS_IMAGE_TAG, 'e-egress');
  assert.equal(EGRESS_HOST_ENV, 'EGRESS_HOST');
  assert.equal(EGRESS_PORTS_ENV, 'EGRESS_PORTS');
});
