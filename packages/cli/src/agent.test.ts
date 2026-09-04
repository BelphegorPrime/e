import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveAgent,
  renderDefaultAgent,
  parseAgent,
  isKnownTarget,
  type Agent,
  type ResolveAgentDeps,
} from './agent';
import { agentDir } from './store';
import type { Provider } from './harness/adapter';
import { renderEnvTemplate } from './harness/renderEnvTemplate';

// resolveAgent is pure: it takes a spawn target plus injected readers (an
// agent loader, the valid harness names, and the available agent names), so we
// exercise the resolution order with fakes — no filesystem.
function deps(overrides: Partial<ResolveAgentDeps> = {}): ResolveAgentDeps {
  return {
    readAgent: () => undefined,
    harnesses: ['claudeCode', 'codex', 'pi'],
    agents: [],
    ...overrides,
  };
}

test('resolveAgent: a persisted agent is returned as-is', () => {
  const smart: Agent = { name: 'smart-codex', harness: 'codex' };
  const agent = resolveAgent(
    'smart-codex',
    deps({ readAgent: n => (n === 'smart-codex' ? smart : undefined) })
  );
  assert.deepEqual(agent, smart);
});
test('renderDefaultAgent: local OmniRoute API key is seeded in the env template', () => {
  const env = renderEnvTemplate({
    harnesses: [{ name: 'codex', env: ['OPENAI_API_KEY'] }],
  });
  assert.match(env, /OPENAI_API_KEY=local-development/);
});

test('resolveAgent: a bare harness name derives its default agent', () => {
  const agent = resolveAgent('pi', deps());
  assert.deepEqual(agent, { name: 'pi', harness: 'pi' });
});

test('resolveAgent: a persisted agent wins over a same-named harness', () => {
  const custom: Agent = { name: 'pi', harness: 'pi' };
  const agent = resolveAgent(
    'pi',
    deps({ readAgent: n => (n === 'pi' ? custom : undefined) })
  );
  assert.equal(agent.name, 'pi');
});

test('resolveAgent: an unknown name throws, listing agents and harnesses', () => {
  assert.throws(
    () => resolveAgent('nope', deps({ agents: ['smart-codex'] })),
    /Unknown agent or harness "nope"[\s\S]*smart-codex[\s\S]*claudeCode/
  );
});

test('resolveAgent: a persisted agent referencing an unknown harness throws', () => {
  const broken: Agent = { name: 'x', harness: 'ghost' };
  assert.throws(
    () => resolveAgent('x', deps({ readAgent: () => broken })),
    /references unknown harness "ghost"/
  );
});

test('resolveAgent: a persisted agent whose name differs from its key throws', () => {
  const mislabelled: Agent = { name: 'other', harness: 'pi' };
  assert.throws(
    () => resolveAgent('pi', deps({ readAgent: () => mislabelled })),
    /declares a different name "other"/
  );
});

test('renderDefaultAgent: defaults provider endpoint to local OmniRoute', () => {
  const parsed = JSON.parse(renderDefaultAgent('codex', {})) as Agent;
  const provider = {
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'http://host.docker.internal:20128/v1',
    baseUrlEnv: 'OPENAI_BASE_URL',
    model: 'auto',
    protocol: 'openai-responses',
    defaultModel: 'auto',
  };
  assert.deepEqual(parsed, {
    name: 'codex',
    harness: 'codex',
    provider: provider,
  });
});

test('renderDefaultAgent: a default agent carries no provider', () => {
  const parsed = JSON.parse(renderDefaultAgent('codex', {})) as Agent;
  const provider = {
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'http://host.docker.internal:20128/v1',
    baseUrlEnv: 'OPENAI_BASE_URL',
    model: 'auto',
    protocol: 'openai-responses',
    defaultModel: 'auto',
  };
  assert.deepStrictEqual(parsed.provider, provider);
});

test('parseAgent: a definition without a provider parses as-is', () => {
  const agent = parseAgent({ name: 'pi', harness: 'pi' }, 'test.json');
  assert.deepEqual(agent, { name: 'pi', harness: 'pi' });
});

test('parseAgent: a valid inline provider is parsed onto the agent', () => {
  const provider: Provider = {
    baseUrl: 'https://gateway.example.com',
    baseUrlEnv: undefined,
    model: 'claude-opus-5',
    protocol: 'anthropic-messages',
    apiKeyEnv: 'MY_GATEWAY_KEY',
  };
  const agent = parseAgent(
    { name: 'smart-claude', harness: 'claudeCode', provider },
    'test.json'
  );
  assert.deepEqual(agent.provider, provider);
});

test('parseAgent: a string[] of default skills is parsed onto the agent', () => {
  const agent = parseAgent(
    {
      name: 'skilled',
      harness: 'claudeCode',
      skills: ['a', 'b'],
    },
    'test.json'
  );
  assert.deepEqual(agent.skills, ['a', 'b']);
});

test('parseAgent: an empty skills array is treated as no baked skills', () => {
  const agent = parseAgent(
    { name: 'x', harness: 'pi', skills: [] },
    'test.json'
  );
  assert.equal(agent.skills, undefined);
});

test('parseAgent: a non-string-array skills field throws', () => {
  assert.throws(
    () =>
      parseAgent({ name: 'x', harness: 'pi', skills: 'a' }, 'test.json'),
    /"skills" must be an array of strings/
  );
});

test('parseAgent: missing required fields throw', () => {
  assert.throws(
    () => parseAgent({ name: 'x' }, 'test.json'),
    /expected \{ name, harness \} strings/
  );
});

test('parseAgent: a provider missing fields throws, naming the source', () => {
  assert.throws(
    () =>
      parseAgent(
        {
          name: 'x',
          harness: 'claudeCode',
          provider: {
            baseUrl: 'https://x',
            model: 'm',
            protocol: 'anthropic-messages',
          },
        },
        'test.json'
      ),
    /Invalid provider[\s\S]*test\.json[\s\S]*apiKeyEnv/
  );
});

test('parseAgent: an unrecognised provider protocol throws, listing valid protocols', () => {
  assert.throws(
    () =>
      parseAgent(
        {
          name: 'x',
          harness: 'claudeCode',
          provider: {
            baseUrl: 'https://x',
            model: 'm',
            protocol: 'not-a-protocol',
            apiKeyEnv: 'K',
          },
        },
        'test.json'
      ),
    /Invalid provider protocol "not-a-protocol"[\s\S]*anthropic-messages/
  );
});

// isKnownTarget is glue over the real store, so it runs against a temp root.
test('isKnownTarget: a known harness is a target; an unknown name is not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-agent-'));
  try {
    assert.equal(isKnownTarget('pi', root), true);
    assert.equal(isKnownTarget('fix the bug', root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isKnownTarget: a persisted agent directory counts as a target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-agent-'));
  try {
    fs.mkdirSync(agentDir('smart-codex', root), { recursive: true });
    assert.equal(isKnownTarget('smart-codex', root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
