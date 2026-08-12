import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseModel, MODEL_PREFERENCES, Tier } from './preferences';

test('chooseModel: returns the first preferred id available for the (protocol, tier)', () => {
  const chosen = chooseModel(
    ['anthropic.claude-sonnet-5', 'anthropic.claude-opus-5', 'anthropic.claude-haiku-4-5'],
    'anthropic-messages',
    'smart',
  );
  // smart prefers opus over sonnet, and opus is available.
  assert.equal(chosen, 'anthropic.claude-opus-5');
});

test('chooseModel: matches a preferred id as a prefix of a versioned available id', () => {
  const chosen = chooseModel(
    ['anthropic.claude-haiku-4-5-20251001-v1:0'],
    'anthropic-messages',
    'cheap',
  );
  // The preferred `anthropic.claude-haiku-4-5` matches the dated/versioned id.
  assert.equal(chosen, 'anthropic.claude-haiku-4-5-20251001-v1:0');
});

test('chooseModel: skips an unavailable top preference for the next available one', () => {
  const chosen = chooseModel(
    ['anthropic.claude-sonnet-5'],
    'anthropic-messages',
    'smart',
  );
  // opus isn't available; sonnet (next in the smart list) is.
  assert.equal(chosen, 'anthropic.claude-sonnet-5');
});

test('chooseModel: does not match a named sibling that merely shares a prefix', () => {
  // smart prefers opus-5 then sonnet-5. A `-thinking` sibling shares the opus-5
  // prefix but is a different variant — it must NOT satisfy the preference, and
  // with no sonnet-5 available and no defaultModel this is a loud failure.
  assert.throws(
    () =>
      chooseModel(
        ['anthropic.claude-opus-5-thinking'],
        'anthropic-messages',
        'smart',
      ),
    /No preferred model/,
  );
});

test('chooseModel: falls back to defaultModel when nothing preferred is available', () => {
  const chosen = chooseModel(
    ['some-unlisted-model'],
    'anthropic-messages',
    'smart',
    'anthropic.claude-sonnet-5',
  );
  assert.equal(chosen, 'anthropic.claude-sonnet-5');
});

test('chooseModel: throws a clear error when nothing matches and no defaultModel', () => {
  assert.throws(
    () => chooseModel(['some-unlisted-model'], 'anthropic-messages', 'smart'),
    /no.*model|preference|available/i,
  );
});

test('chooseModel: an unknown tier with no defaultModel is a clear error', () => {
  assert.throws(
    () => chooseModel(['anthropic.claude-opus-5'], 'anthropic-messages', 'default'),
    /tier|preference/i,
  );
});

test('MODEL_PREFERENCES: the curated protocols each cover the four tiers', () => {
  const tiers: Tier[] = ['smart', 'fast', 'cheap', 'review'];
  const protocols = ['anthropic-messages', 'openai-responses', 'openai-chat'] as const;
  for (const protocol of protocols) {
    const rows = MODEL_PREFERENCES[protocol];
    assert.ok(rows, `${protocol} missing`);
    for (const tier of tiers) {
      assert.ok(
        Array.isArray(rows[tier]) && rows[tier].length > 0,
        `${protocol}/${tier} missing`,
      );
    }
  }
});
