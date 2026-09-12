import { test } from 'node:test';
import assert from 'node:assert/strict';
import { a2aAccess, bearerMatches, isLoopbackHost } from './access.js';
import { agentSkill, renderAgentCard } from './agentCard.js';
import {
  expandEnvRefs,
  parseRemoteA2aAgent,
  resolveRemoteHeaders,
} from './remoteAgent.js';

test('a2aAccess: open on loopback without a token, bearer with one; off beyond loopback without one', () => {
  assert.deepEqual(a2aAccess({ host: '127.0.0.1' }), {
    enabled: true,
    requireBearer: false,
  });
  assert.deepEqual(a2aAccess({ host: 'localhost', token: ' s3cret ' }), {
    enabled: true,
    requireBearer: true,
    token: 's3cret',
  });
  const off = a2aAccess({ host: '0.0.0.0', token: '' });
  assert.equal(off.enabled, false);
  assert.match(
    off.enabled ? '' : off.reason,
    /beyond loopback; set E_A2A_TOKEN/
  );
  assert.deepEqual(a2aAccess({ host: '0.0.0.0', token: 't' }), {
    enabled: true,
    requireBearer: true,
    token: 't',
  });
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('192.168.1.5'), false);
});

test('bearerMatches: the exact token behind "Bearer", nothing else', () => {
  assert.equal(bearerMatches('Bearer abc', 'abc'), true);
  assert.equal(bearerMatches('bearer abc', 'abc'), true);
  assert.equal(bearerMatches('Bearer abd', 'abc'), false);
  assert.equal(bearerMatches('Bearer ab', 'abc'), false);
  assert.equal(bearerMatches('Basic abc', 'abc'), false);
  assert.equal(bearerMatches(undefined, 'abc'), false);
});

test('renderAgentCard: one JSON-RPC interface, one skill per harness agent, bearer scheme only when required', () => {
  const card = renderAgentCard({
    url: 'http://127.0.0.1:8080/a2a',
    version: '1.2.3',
    agents: [
      { name: 'pi', harness: 'pi', model: 'auto/coding', default: true },
      { name: 'smart-codex', harness: 'codex', model: null, default: false },
    ],
    bearer: false,
    repository: 'acme/app',
  });
  assert.equal(card.name, 'e');
  assert.equal(card.version, '1.2.3');
  assert.match(card.description, /acme\/app/);
  assert.deepEqual(card.supportedInterfaces, [
    {
      url: 'http://127.0.0.1:8080/a2a',
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    },
  ]);
  assert.deepEqual(card.capabilities, {
    streaming: true,
    pushNotifications: false,
    extendedAgentCard: false,
  });
  assert.deepEqual(
    card.skills.map(skill => [skill.id, skill.tags]),
    [
      ['pi', ['coding', 'git', 'pi', 'default']],
      ['smart-codex', ['coding', 'git', 'codex']],
    ]
  );
  assert.match(card.skills[0].description, /model auto\/coding/);
  assert.match(card.skills[0].description, /metadata\.agent/);
  assert.equal(card.securitySchemes, undefined);
  assert.equal(card.securityRequirements, undefined);

  const secured = renderAgentCard({
    url: 'http://h:1/a2a',
    version: '1',
    agents: [],
    bearer: true,
  });
  // The A2A 1.0 (proto JSON) shapes, not the 0.x `type` discriminator.
  assert.deepEqual(secured.securitySchemes, {
    bearer: {
      httpAuthSecurityScheme: {
        scheme: 'bearer',
        description: 'The E_A2A_TOKEN of the e serve process',
      },
    },
  });
  assert.deepEqual(secured.securityRequirements, [
    { schemes: { bearer: { list: [] } } },
  ]);
  assert.deepEqual(
    agentSkill({ name: 'x', harness: 'pi', model: null, default: false })
      .inputModes,
    ['text/plain']
  );
});

test('parseRemoteA2aAgent + expandEnvRefs + resolveRemoteHeaders: ${VAR} headers resolve from the store env, a hole is an error naming it', () => {
  const agent = parseRemoteA2aAgent(
    {
      name: 'r',
      transport: 'a2a',
      url: 'https://x/a2a',
      headers: { Authorization: 'Bearer ${TOKEN}', 'X-Team': 'e' },
    },
    'r.json'
  );
  assert.deepEqual(resolveRemoteHeaders(agent, { TOKEN: 'abc' }), {
    Authorization: 'Bearer abc',
    'X-Team': 'e',
  });
  assert.throws(
    () => resolveRemoteHeaders(agent, {}),
    /Header "Authorization" of remote agent "r" references \$\{TOKEN\}, which is not set in \.e\/\.env/
  );
  assert.equal(expandEnvRefs('${A}-${B}', { A: '1', B: '2' }, 'x'), '1-2');
  assert.equal(expandEnvRefs('plain', {}, 'x'), 'plain');
  assert.throws(
    () =>
      parseRemoteA2aAgent(
        { name: 'r', url: 'https://x', requiredEnv: 'T' },
        'r.json'
      ),
    /"requiredEnv" must be an array/
  );
  assert.throws(
    () =>
      parseRemoteA2aAgent(
        { name: 'r', url: 'https://x', description: 1 },
        'r.json'
      ),
    /"description" must be a string/
  );
});
