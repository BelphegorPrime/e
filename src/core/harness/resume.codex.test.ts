import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARNESSES, harnessCapabilities } from './index.js';
import { renderDockerfile } from './renderDockerfile.js';

const codex = HARNESSES.codex;

test('codex resumeCommand continues the newest session one-shot with exec resume --last (ADR-0017)', () => {
  assert.deepEqual(codex.resumeCommand!('go on'), [
    'codex',
    'exec',
    'resume',
    '--last',
    '--dangerously-bypass-approvals-and-sandbox',
    '--ignore-rules',
    'go on',
  ]);
});

test('codex resumeCommand names a runtime-resolved model with -m before the prompt', () => {
  assert.deepEqual(codex.resumeCommand!('go on', 'gpt-6'), [
    'codex',
    'exec',
    'resume',
    '--last',
    '--dangerously-bypass-approvals-and-sandbox',
    '--ignore-rules',
    '-m',
    'gpt-6',
    'go on',
  ]);
});

test('codex resumeCommand keeps the write-enabled posture: a resumed exec does not inherit it', () => {
  // Without the bypass a resumed `codex exec` runs read-only and exits 0
  // having written nothing (measured on 0.159.0), ADR-0016's live bug again.
  for (const model of [undefined, 'gpt-6']) {
    const argv = codex.resumeCommand!('go on', model);
    assert.ok(argv.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(argv.includes('--ignore-rules'));
    assert.ok(!argv.includes('--dangerously-bypass-hook-trust'));
    assert.equal(argv.at(-1), 'go on');
  }
  // The same posture as a fresh run, flag for flag.
  const fresh = codex.buildCommand('go on');
  const resumed = codex.resumeCommand!('go on');
  assert.deepEqual(resumed.slice(4, -1), fresh.slice(2, -1));
});

test('codex resumeCommand without a prompt reopens the session in the TUI, exec sessions included', () => {
  assert.deepEqual(codex.resumeCommand!(undefined), [
    'codex',
    'resume',
    '--last',
    '--include-non-interactive',
  ]);
  assert.deepEqual(codex.resumeCommand!(undefined, 'gpt-6'), [
    'codex',
    'resume',
    '--last',
    '--include-non-interactive',
    '-m',
    'gpt-6',
  ]);
  // The TUI keeps buildInteractiveCommand's attended posture.
  assert.ok(
    !codex.resumeCommand!(undefined).includes(
      '--dangerously-bypass-approvals-and-sandbox'
    )
  );
});

test('codex keeps its sessions under CODEX_HOME/sessions, outside /workspace and not CODEX_HOME itself', () => {
  assert.equal(codex.sessionDir, '/home/node/.codex/sessions');
  assert.ok(!codex.sessionDir!.startsWith('/workspace'));
  // A subdir: the mount never shadows the baked or mounted config.toml.
  assert.notEqual(codex.sessionDir, '/home/node/.codex');
  assert.notEqual(codex.sessionDir, '/home/node/.codex/config.toml');
  assert.ok(codex.sessionDir!.startsWith('/home/node/.codex/'));
});

test('the codex image creates CODEX_HOME before the chown, so the session mount leaves it node-owned', () => {
  const dockerfile = renderDockerfile(codex.dockerfile);
  const mkdir = dockerfile.indexOf('RUN mkdir -p /home/node/.codex\n');
  const chown = dockerfile.indexOf('RUN chown -R node:node /home/node\n');
  assert.ok(mkdir > 0, dockerfile);
  assert.ok(chown > mkdir, dockerfile);
});

test('harnessCapabilities.resume is true for codex', () => {
  assert.equal(harnessCapabilities(codex).resume, true);
});

test("codex's image says in a label that it created CODEX_HOME for the mount", () => {
  assert.match(
    renderDockerfile(HARNESSES.codex.dockerfile),
    /e\.harness\.session-parent="\/home\/node\/\.codex"/
  );
});
