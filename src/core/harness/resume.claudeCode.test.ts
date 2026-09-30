import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARNESSES, harnessCapabilities } from './index.js';

const claude = HARNESSES.claudeCode;
/** The #153 posture every Claude invocation carries, resumed or not. */
const ISOLATION = [
  '--strict-mcp-config',
  '--settings',
  '{"disableAllHooks":true}',
];

test('claudeCode resumeCommand continues the most recent session one-shot, with the follow-up (ADR-0017)', () => {
  assert.deepEqual(claude.resumeCommand!('go on'), [
    'claude',
    '--continue',
    '-p',
    'go on',
    '--dangerously-skip-permissions',
    ...ISOLATION,
  ]);
});

test('claudeCode resumeCommand ignores a model, as buildCommand does (the env adapter carries it)', () => {
  assert.deepEqual(
    claude.resumeCommand!('go on', 'claude-opus-5'),
    claude.resumeCommand!('go on')
  );
  assert.deepEqual(
    claude.resumeCommand!(undefined, 'claude-opus-5'),
    claude.resumeCommand!(undefined)
  );
});

test('claudeCode resumeCommand without a prompt reopens the session in the TUI, with the interactive posture', () => {
  assert.deepEqual(claude.resumeCommand!(undefined), [
    'claude',
    '--continue',
    '--dangerously-skip-permissions',
    ...ISOLATION,
  ]);
  assert.ok(!claude.resumeCommand!(undefined).includes('-p'));
});

test('claudeCode resumed argv keeps everything buildCommand and buildInteractiveCommand pass (#153)', () => {
  const oneShot = claude.resumeCommand!('go on');
  for (const arg of claude.buildCommand('go on')) {
    assert.ok(oneShot.includes(arg), arg);
  }
  const tui = claude.resumeCommand!(undefined);
  for (const arg of claude.buildInteractiveCommand()) {
    assert.ok(tui.includes(arg), arg);
  }
});

test('claudeCode keeps its sessions under ~/.claude/projects, outside /workspace and apart from skills and config', () => {
  assert.equal(claude.sessionDir, '/home/node/.claude/projects');
  assert.ok(!claude.sessionDir!.startsWith('/workspace'));
  // The mount must not shadow the skills dir or the config home itself.
  assert.notEqual(claude.sessionDir, claude.skillsDir);
  assert.ok(!claude.skillsDir!.startsWith(`${claude.sessionDir}/`));
  assert.notEqual(claude.sessionDir, '/home/node/.claude');
});

test('harnessCapabilities(claudeCode).resume is true', () => {
  assert.equal(harnessCapabilities(claude).resume, true);
});
