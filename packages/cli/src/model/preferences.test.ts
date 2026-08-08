import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseModel, MODEL_PREFERENCES } from './preferences';

test('chooseModel: returns the first preferred id available for the (protocol, tier)', () => {
  const chosen = chooseModel(
    ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'],
    'anthropic-messages',
    'smart',
  );
  // smart prefers opus over sonnet, and opus is available.
  assert.equal(chosen, 'claude-opus-5');
});

test('chooseModel: matches a preferred id as a prefix of a versioned available id', () => {
  const chosen = chooseModel(
    ['claude-opus-5-20260101', 'claude-sonnet-5-20260101'],
    'anthropic-messages',
    'smart',
  );
  // The preferred `claude-opus-5` prefix-matches the dated id, which is returned verbatim.
  assert.equal(chosen, 'claude-opus-5-20260101');
});

test('chooseModel: does not match a named sibling family that merely shares a prefix', () => {
  // `smart` prefers `gpt-5` then `gpt-5-codex`. `gpt-5-mini` shares the `gpt-5`
  // prefix but is a different (cheaper) family — it must NOT satisfy `gpt-5`.
  const chosen = chooseModel(
    ['gpt-5-mini', 'gpt-5-codex'],
    'openai-chat',
    'smart',
  );
  assert.equal(chosen, 'gpt-5-codex');
});

test('chooseModel: prefers an exact id even when a sibling is listed first', () => {
  const chosen = chooseModel(['gpt-5-mini', 'gpt-5'], 'openai-chat', 'smart');
  assert.equal(chosen, 'gpt-5');
});

test('chooseModel: skips an unavailable top preference for the next available one', () => {
  const chosen = chooseModel(
    ['claude-sonnet-5'],
    'anthropic-messages',
    'smart',
  );
  // opus isn't available; sonnet (next in the smart list) is.
  assert.equal(chosen, 'claude-sonnet-5');
});

test('chooseModel: falls back to defaultModel when nothing preferred is available', () => {
  const chosen = chooseModel(
    ['some-unlisted-model'],
    'anthropic-messages',
    'smart',
    'claude-sonnet-5',
  );
  assert.equal(chosen, 'claude-sonnet-5');
});

test('chooseModel: throws a clear error when nothing matches and no defaultModel', () => {
  assert.throws(
    () => chooseModel(['some-unlisted-model'], 'anthropic-messages', 'smart'),
    /no.*model|preference|available/i,
  );
});

test('chooseModel: an unknown tier with no defaultModel is a clear error', () => {
  assert.throws(
    () => chooseModel(['claude-opus-5'], 'anthropic-messages', 'default'),
    /tier|preference/i,
  );
});

test('MODEL_PREFERENCES: covers the four curated tiers for every protocol', () => {
  const tiers = ['smart', 'fast', 'cheap', 'review'];
  for (const protocol of Object.keys(MODEL_PREFERENCES)) {
    for (const tier of tiers) {
      const list = MODEL_PREFERENCES[protocol as keyof typeof MODEL_PREFERENCES][tier];
      assert.ok(Array.isArray(list) && list.length > 0, `${protocol}/${tier} missing`);
    }
  }
});
