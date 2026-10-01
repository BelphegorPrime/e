import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, HarnessAgent } from '../agent/agent.js';
import {
  agentDestinations,
  assertProviderPolicy,
  parseProviderPolicy,
  providerPolicyViolations,
} from './providerPolicy.js';

/*
 * The provider policy (#180, ADR-0019 section 10): which destinations a
 * Store lets its code and prompts reach, checked before anything is built -
 * for a fusion over every candidate and the synthesizer at once, for a
 * spawn over its one Agent, for a Remote agent over its URL.
 */

const agent = (
  name: string,
  harness: string,
  provider?: Partial<NonNullable<HarnessAgent['provider']>>
): HarnessAgent => ({
  name,
  harness,
  ...(provider
    ? {
        provider: {
          baseUrl: 'https://api.example.com/v1',
          model: 'm',
          protocol: 'openai-chat',
          apiKeyEnv: 'KEY',
          ...provider,
        },
      }
    : {}),
});
const remote: Agent = {
  name: 'helper',
  transport: 'a2a',
  url: 'https://agents.partner.example/a2a',
};
const store = (vars: Record<string, string> = {}) => ({ store: vars });

test('parseProviderPolicy: absent is no policy; patterns are normalized', () => {
  assert.equal(parseProviderPolicy(undefined), undefined);
  assert.deepEqual(
    parseProviderPolicy({
      allow: [
        '*.Anthropic.com.',
        'localhost',
        'harness:claudeCode',
        '[0:0::1]',
      ],
      deny: ['API.OPENAI.COM', '0x7f.1'],
    }),
    {
      allow: ['*.anthropic.com', 'localhost', 'harness:claudecode', '[::1]'],
      deny: ['api.openai.com', '127.0.0.1'],
    }
  );
  assert.deepEqual(parseProviderPolicy({ deny: ['*'] }), { deny: ['*'] });
});

test('parseProviderPolicy: a malformed policy is kept as invalid, never dropped', () => {
  // Dropping a deny rule would quietly allow what it denied: fail closed.
  for (const raw of [
    'deny everything',
    { deny: 'api.openai.com' },
    { deny: [42] },
    { deny: ['https://api.openai.com/v1'] },
    { deny: ['api.openai.com:443'] },
    { allow: ['*.'] },
    { block: ['x'] },
  ]) {
    const policy = parseProviderPolicy(raw);
    assert.ok(policy?.invalid, JSON.stringify(raw));
  }
});

test('agentDestinations: where each harness actually sends, as its config adapter renders it', () => {
  const both = { baseUrl: 'https://literal.example/v1', baseUrlEnv: 'BASE' };
  const env = store({ BASE: 'https://from-env.example/v1' });
  // Claude Code and Codex take the literal baseUrl, whatever baseUrlEnv says.
  assert.deepEqual(agentDestinations(agent('c', 'claudeCode', both), env), [
    'literal.example',
  ]);
  assert.deepEqual(agentDestinations(agent('x', 'codex', both), env), [
    'literal.example',
  ]);
  // pi takes the env value, opencode too, falling back to the literal.
  assert.deepEqual(agentDestinations(agent('p', 'pi', both), env), [
    'from-env.example',
  ]);
  assert.deepEqual(agentDestinations(agent('o', 'opencode', both), store()), [
    'literal.example',
  ]);
  // pi with an unset env value sends nowhere it can be checked.
  assert.deepEqual(agentDestinations(agent('p', 'pi', both), store()), [null]);
});

test('agentDestinations: hosts are normalized: case, port, path, a trailing dot, an IP spelled oddly', () => {
  const at = (baseUrl: string) =>
    agentDestinations(agent('c', 'claudeCode', { baseUrl }), store());
  assert.deepEqual(at('https://API.OpenAI.com.:443/v1'), ['api.openai.com']);
  assert.deepEqual(at('http://0x7f.1:20128/v1'), ['127.0.0.1']);
  assert.deepEqual(at('https://user:pw@api.openai.com/'), ['api.openai.com']);
  assert.deepEqual(at('not a url'), [null]);
});

test('agentDestinations: without a provider, the global base URLs the container receives, else the harness default', () => {
  assert.deepEqual(agentDestinations(agent('c', 'claudeCode'), store()), [
    'harness:claudeCode',
  ]);
  // `.e/.env`'s ANTHROPIC_BASE_URL / OPENAI_BASE_URL reach every container,
  // and so do the `--env-file` and `-e` layers.
  assert.deepEqual(
    agentDestinations(agent('c', 'claudeCode'), {
      store: { ANTHROPIC_BASE_URL: 'http://localhost:20128' },
      container: [{ OPENAI_BASE_URL: 'https://gw.example/v1' }],
    }),
    ['localhost', 'gw.example']
  );
});

test('agentDestinations: a Remote agent sends to its URL', () => {
  assert.deepEqual(agentDestinations(remote, store()), [
    'agents.partner.example',
  ]);
});

test('providerPolicyViolations: deny wins, an allow list admits only what it names', () => {
  const policy = parseProviderPolicy({
    allow: ['*.anthropic.com', 'localhost', 'harness:claudecode'],
    deny: ['evil.anthropic.com'],
  })!;
  const at = (name: string, baseUrl: string) =>
    agent(name, 'claudeCode', { baseUrl });
  assert.deepEqual(
    providerPolicyViolations(
      policy,
      [
        at('claude-api', 'https://api.anthropic.com'),
        at('local', 'http://localhost:20128/v1'),
        agent('claude', 'claudeCode'),
      ],
      store()
    ),
    []
  );
  assert.deepEqual(
    providerPolicyViolations(
      policy,
      [
        at('evil', 'https://evil.anthropic.com'),
        // A trailing dot is the same host, never a way around a rule.
        at('evil-dot', 'https://evil.anthropic.com./'),
        at('codex', 'https://api.openai.com/v1'),
        // `*.anthropic.com` is the subdomains: not the apex, not a look-alike.
        at('apex', 'https://anthropic.com'),
        at('lookalike', 'https://evil-anthropic.com'),
        remote,
      ],
      store()
    ),
    [
      {
        agent: 'evil',
        destination: 'evil.anthropic.com',
        why: 'denied by "evil.anthropic.com"',
      },
      {
        agent: 'evil-dot',
        destination: 'evil.anthropic.com',
        why: 'denied by "evil.anthropic.com"',
      },
      {
        agent: 'codex',
        destination: 'api.openai.com',
        why: 'not in the allow list',
      },
      {
        agent: 'apex',
        destination: 'anthropic.com',
        why: 'not in the allow list',
      },
      {
        agent: 'lookalike',
        destination: 'evil-anthropic.com',
        why: 'not in the allow list',
      },
      {
        agent: 'helper',
        destination: 'agents.partner.example',
        why: 'not in the allow list',
      },
    ]
  );
  // Every destination of one Agent must pass.
  assert.deepEqual(
    providerPolicyViolations(
      { deny: ['gw.example'] },
      [agent('c', 'claudeCode')],
      {
        store: { ANTHROPIC_BASE_URL: 'http://localhost:20128' },
        container: [{ OPENAI_BASE_URL: 'https://gw.example/v1' }],
      }
    ),
    [{ agent: 'c', destination: 'gw.example', why: 'denied by "gw.example"' }]
  );
  assert.deepEqual(
    providerPolicyViolations(
      { deny: ['*'] },
      [agent('c', 'claudeCode')],
      store()
    ),
    [{ agent: 'c', destination: 'harness:claudeCode', why: 'denied by "*"' }]
  );
  // Without a policy, nothing is refused.
  assert.deepEqual(
    providerPolicyViolations(undefined, [agent('c', 'claudeCode')], store()),
    []
  );
});

test('providerPolicyViolations: a destination that cannot be resolved is refused under any policy', () => {
  assert.deepEqual(
    providerPolicyViolations(
      { deny: ['api.openai.com'] },
      [agent('p', 'pi', { baseUrlEnv: 'MISSING' })],
      store()
    ),
    [
      {
        agent: 'p',
        destination: null,
        why: 'its base URL does not resolve, so where it sends cannot be checked',
      },
    ]
  );
});

test('providerPolicyViolations: a malformed policy refuses every Agent, saying why', () => {
  const policy = parseProviderPolicy({ deny: 'x' });
  assert.deepEqual(
    providerPolicyViolations(policy, [agent('c', 'claudeCode')], store()),
    [
      {
        agent: 'c',
        destination: 'harness:claudeCode',
        why: `the policy is invalid: ${policy!.invalid}`,
      },
    ]
  );
});

test('assertProviderPolicy: one message naming every refused Agent, each role it fills', () => {
  const policy = parseProviderPolicy({ deny: ['api.openai.com'] });
  const codex = agent('codex', 'codex', {
    baseUrl: 'https://api.openai.com/v1',
  });
  assert.doesNotThrow(() =>
    assertProviderPolicy(
      policy,
      [{ role: 'agent', agent: agent('c', 'claudeCode') }],
      store(),
      'this run'
    )
  );
  assert.throws(
    () =>
      assertProviderPolicy(
        policy,
        [
          { role: 'candidate', agent: codex },
          { role: 'candidate', agent: codex },
          { role: 'synthesizer', agent: codex },
          { role: 'candidate', agent: agent('c', 'claudeCode') },
        ],
        store(),
        'fusion profile "mix"'
      ),
    (err: Error) => {
      assert.equal(
        err.message,
        'The provider policy in config.json "providers" refuses fusion profile "mix":\n' +
          '  candidate and synthesizer "codex" sends to api.openai.com: denied by "api.openai.com"'
      );
      return true;
    }
  );
});
