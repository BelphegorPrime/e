import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHarnessChoice, applyEnvValues, keysToPrompt } from './init';

// parseHarnessChoice is pure: it maps a prompt answer to a harness name, taking
// the fallback for a blank answer and undefined for anything unrecognized.
const NAMES = ['pi', 'claudeCode', 'codex', 'opencode'];

test('parseHarnessChoice: a blank answer takes the fallback', () => {
  assert.equal(parseHarnessChoice('', NAMES, 'pi'), 'pi');
  assert.equal(parseHarnessChoice('   ', NAMES, 'pi'), 'pi');
});

test('parseHarnessChoice: an exact name (trimmed) selects it', () => {
  assert.equal(parseHarnessChoice('codex', NAMES, 'pi'), 'codex');
  assert.equal(parseHarnessChoice('  opencode  ', NAMES, 'pi'), 'opencode');
});

test('parseHarnessChoice: a 1-based index selects that harness', () => {
  assert.equal(parseHarnessChoice('1', NAMES, 'pi'), 'pi');
  assert.equal(parseHarnessChoice('3', NAMES, 'pi'), 'codex');
});

test('parseHarnessChoice: an out-of-range index or unknown name is unrecognized', () => {
  assert.equal(parseHarnessChoice('0', NAMES, 'pi'), undefined);
  assert.equal(parseHarnessChoice('99', NAMES, 'pi'), undefined);
  assert.equal(parseHarnessChoice('nope', NAMES, 'pi'), undefined);
});

// applyEnvValues is pure: it fills blank `KEY=` lines with collected values and
// leaves everything else — filled keys, comments, unmatched keys — untouched.
test('applyEnvValues: fills a blank key with its collected value', () => {
  const out = applyEnvValues('ANTHROPIC_API_KEY=\nOPENAI_API_KEY=\n', {
    ANTHROPIC_API_KEY: 'sk-abc',
  });
  assert.equal(out, 'ANTHROPIC_API_KEY=sk-abc\nOPENAI_API_KEY=\n');
});

test('applyEnvValues: never clobbers an already-filled key', () => {
  const out = applyEnvValues('ANTHROPIC_API_KEY=existing\n', {
    ANTHROPIC_API_KEY: 'sk-new',
  });
  assert.equal(out, 'ANTHROPIC_API_KEY=existing\n');
});

test('applyEnvValues: an empty collected value leaves the blank line as-is', () => {
  const out = applyEnvValues('OPENAI_API_KEY=\n', { OPENAI_API_KEY: '' });
  assert.equal(out, 'OPENAI_API_KEY=\n');
});

test('applyEnvValues: comments and unrelated lines are preserved', () => {
  const input = '# a comment\n\nANTHROPIC_API_KEY=\n# --- pi ---\n';
  const out = applyEnvValues(input, { ANTHROPIC_API_KEY: 'sk-abc' });
  assert.equal(out, '# a comment\n\nANTHROPIC_API_KEY=sk-abc\n# --- pi ---\n');
});

// keysToPrompt is pure: it drops keys already filled in the existing `.env`.
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

test('keysToPrompt: no existing .env prompts for every required key', () => {
  assert.deepEqual(keysToPrompt(KEYS, undefined), KEYS);
});

test('keysToPrompt: a filled key is skipped', () => {
  assert.deepEqual(keysToPrompt(KEYS, 'ANTHROPIC_API_KEY=sk-abc\nOPENAI_API_KEY=\n'), [
    'OPENAI_API_KEY',
  ]);
});

test('keysToPrompt: a blank (KEY=) or whitespace-only key still prompts', () => {
  assert.deepEqual(keysToPrompt(KEYS, 'ANTHROPIC_API_KEY=\nOPENAI_API_KEY=   \n'), KEYS);
});

test('keysToPrompt: all keys filled leaves nothing to prompt', () => {
  assert.deepEqual(
    keysToPrompt(KEYS, 'ANTHROPIC_API_KEY=sk-abc\nOPENAI_API_KEY=sk-def\n'),
    [],
  );
});
