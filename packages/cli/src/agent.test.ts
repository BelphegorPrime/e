import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgent, renderDefaultAgent, type Agent, type ResolveAgentDeps } from './agent';

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
  const smart: Agent = { name: 'smart-codex', harness: 'codex', tier: 'smart' };
  const agent = resolveAgent(
    'smart-codex',
    deps({ readAgent: (n) => (n === 'smart-codex' ? smart : undefined) }),
  );
  assert.deepEqual(agent, smart);
});

test('resolveAgent: a bare harness name derives its default agent', () => {
  const agent = resolveAgent('pi', deps());
  assert.deepEqual(agent, { name: 'pi', harness: 'pi', tier: 'default' });
});

test('resolveAgent: a persisted agent wins over a same-named harness', () => {
  const custom: Agent = { name: 'pi', harness: 'pi', tier: 'smart' };
  const agent = resolveAgent(
    'pi',
    deps({ readAgent: (n) => (n === 'pi' ? custom : undefined) }),
  );
  assert.equal(agent.tier, 'smart');
});

test('resolveAgent: an unknown name throws, listing agents and harnesses', () => {
  assert.throws(
    () => resolveAgent('nope', deps({ agents: ['smart-codex'] })),
    /Unknown agent or harness "nope"[\s\S]*smart-codex[\s\S]*claudeCode/,
  );
});

test('resolveAgent: a persisted agent referencing an unknown harness throws', () => {
  const broken: Agent = { name: 'x', harness: 'ghost', tier: 'default' };
  assert.throws(
    () => resolveAgent('x', deps({ readAgent: () => broken })),
    /references unknown harness "ghost"/,
  );
});

test('resolveAgent: a persisted agent whose name differs from its key throws', () => {
  const mislabelled: Agent = { name: 'other', harness: 'pi', tier: 'default' };
  assert.throws(
    () => resolveAgent('pi', deps({ readAgent: () => mislabelled })),
    /declares a different name "other"/,
  );
});

test('renderDefaultAgent: valid JSON with name=harness and tier=default', () => {
  const parsed = JSON.parse(renderDefaultAgent('codex')) as Agent;
  assert.deepEqual(parsed, { name: 'codex', harness: 'codex', tier: 'default' });
});
