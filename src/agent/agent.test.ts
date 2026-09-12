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
  listAgents,
  findAgent,
  isRemoteAgent,
  type Agent,
  type HarnessAgent,
  type ResolveAgentDeps,
} from './agent.js';
import { agentDir } from '../store/paths.js';
import type { Provider } from '../harness/adapter.js';
import { renderEnvTemplate } from '../harness/renderEnvTemplate.js';

// resolveAgent is pure: it takes a spawn target plus injected readers (an
// agent loader, the valid harness names, and the available agent names), so we
// exercise the resolution order with fakes - no filesystem.
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
  const parsed = JSON.parse(renderDefaultAgent('codex', {})) as HarnessAgent;
  const provider = {
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'http://localhost:20128/v1',
    baseUrlEnv: 'OPENAI_BASE_URL',
    model: 'auto/coding',
    protocol: 'openai-responses',
  };
  assert.deepEqual(parsed, {
    name: 'codex',
    harness: 'codex',
    provider: provider,
    skills: ['web-search'],
  });
});

test('renderDefaultAgent: a default agent carries no provider', () => {
  const parsed = JSON.parse(renderDefaultAgent('codex', {})) as HarnessAgent;
  const provider = {
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'http://localhost:20128/v1',
    baseUrlEnv: 'OPENAI_BASE_URL',
    model: 'auto/coding',
    protocol: 'openai-responses',
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
  ) as HarnessAgent;
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
  ) as HarnessAgent;
  assert.deepEqual(agent.skills, ['a', 'b']);
});

test('parseAgent: an empty skills array is treated as no baked skills', () => {
  const agent = parseAgent(
    { name: 'x', harness: 'pi', skills: [] },
    'test.json'
  ) as HarnessAgent;
  assert.equal(agent.skills, undefined);
});

test('parseAgent: a non-string-array skills field throws', () => {
  assert.throws(
    () => parseAgent({ name: 'x', harness: 'pi', skills: 'a' }, 'test.json'),
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

test('listAgents: an empty store yields no agents ', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-agent-'));
  try {
    assert.deepEqual(listAgents(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listAgents: reads every persisted agent, skipping non-directory entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-agent-'));
  try {
    fs.mkdirSync(agentDir('smart-codex', root), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir('smart-codex', root), 'agent.json'),
      JSON.stringify({ name: 'smart-codex', harness: 'codex' })
    );
    fs.mkdirSync(agentDir('claude-pr', root), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir('claude-pr', root), 'agent.json'),
      JSON.stringify({ name: 'claude-pr', harness: 'claudeCode' })
    );
    fs.writeFileSync(
      path.join(agentDir('smart-codex', root), '.DS_Store'),
      'junk'
    );
    const agents = listAgents(root);
    assert.deepEqual(agents.map(a => a.name).sort(), [
      'claude-pr',
      'smart-codex',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findAgent: resolves a persisted agent by name against the real store', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-agent-'));
  try {
    fs.mkdirSync(agentDir('smart-codex', root), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir('smart-codex', root), 'agent.json'),
      JSON.stringify({ name: 'smart-codex', harness: 'codex' })
    );
    assert.deepEqual(findAgent('smart-codex', root), {
      name: 'smart-codex',
      harness: 'codex',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findAgent: an unknown name throws, listing the valid targets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-agent-'));
  try {
    assert.throws(
      () => findAgent('nope', root),
      (error: Error) => {
        assert.match(error.message, /Unknown agent or harness "nope"/);
        return true;
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Remote A2A agents (ADR-0015): `transport: "a2a"` in agent.json names an
// agent hosted elsewhere; no harness, a URL, headers with `${VAR}` references.

test('parseAgent: transport "a2a" parses a remote agent with url, headers, requiredEnv and description', () => {
  const agent = parseAgent(
    {
      name: 'remote-researcher',
      transport: 'a2a',
      url: 'https://agents.example.com/a2a',
      headers: { Authorization: 'Bearer ${RESEARCH_TOKEN}' },
      requiredEnv: ['RESEARCH_TOKEN'],
      description: 'Answers research questions',
    },
    'test.json'
  );
  assert.equal(isRemoteAgent(agent), true);
  assert.deepEqual(agent, {
    name: 'remote-researcher',
    transport: 'a2a',
    url: 'https://agents.example.com/a2a',
    headers: { Authorization: 'Bearer ${RESEARCH_TOKEN}' },
    requiredEnv: ['RESEARCH_TOKEN'],
    description: 'Answers research questions',
  });
  assert.equal(isRemoteAgent({ name: 'pi', harness: 'pi' }), false);
});

test('parseAgent: a remote agent without an http(s) url, or with malformed headers, throws naming the source', () => {
  assert.throws(
    () => parseAgent({ name: 'r', transport: 'a2a' }, 'r.json'),
    /r\.json: a remote A2A agent needs an http\(s\) "url"/
  );
  assert.throws(
    () => parseAgent({ name: 'r', transport: 'a2a', url: 'ftp://x' }, 'r.json'),
    /http\(s\) "url"/
  );
  assert.throws(
    () =>
      parseAgent(
        { name: 'r', transport: 'a2a', url: 'https://x', headers: { a: 1 } },
        'r.json'
      ),
    /"headers" must be an object of string values/
  );
  assert.throws(
    () => parseAgent({ transport: 'a2a', url: 'https://x' }, 'r.json'),
    /needs a "name"/
  );
});

test('resolveAgent: a persisted remote agent resolves without a harness check', () => {
  const remote: Agent = {
    name: 'remote-researcher',
    transport: 'a2a',
    url: 'https://agents.example.com/a2a',
  };
  const agent = resolveAgent(
    'remote-researcher',
    deps({ readAgent: n => (n === 'remote-researcher' ? remote : undefined) })
  );
  assert.deepEqual(agent, remote);
});

test('listAgents and findAgent: a remote agent.json in the store is listed and found next to harness agents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-agents-remote-'));
  try {
    fs.mkdirSync(agentDir('pi', root), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir('pi', root), 'agent.json'),
      JSON.stringify({ name: 'pi', harness: 'pi' })
    );
    fs.mkdirSync(agentDir('remote', root), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir('remote', root), 'agent.json'),
      JSON.stringify({ name: 'remote', transport: 'a2a', url: 'https://x/a2a' })
    );
    assert.deepEqual(
      listAgents(root)
        .map(a => a.name)
        .sort(),
      ['pi', 'remote']
    );
    const found = findAgent('remote', root);
    assert.equal(isRemoteAgent(found), true);
    assert.equal(isKnownTarget('remote', root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
