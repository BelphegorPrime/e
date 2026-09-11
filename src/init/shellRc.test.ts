import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { completionSourceCommand, ensureShellRcEntry } from './shellRc.js';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e-shellrc-test-'));
}

test('completionSourceCommand: picks the right loader per shell', () => {
  assert.equal(completionSourceCommand('bash'), 'source <(e completion bash)');
  assert.equal(completionSourceCommand('zsh'), 'source <(e completion zsh)');
  assert.equal(completionSourceCommand('fish'), 'source <(e completion fish)');
  assert.equal(
    completionSourceCommand('powershell'),
    'e completion powershell | Out-String | Invoke-Expression'
  );
});

test('ensureShellRcEntry: creates the rc file and appends a guarded block', () => {
  const home = tempHome();
  const result = ensureShellRcEntry('bash', home);
  assert.equal(result.status, 'added');
  assert.equal((result as { file: string }).file, path.join(home, '.bashrc'));
  const content = fs.readFileSync(path.join(home, '.bashrc'), 'utf8');
  assert.match(content, /# >>> e shell completion >>>/);
  assert.match(content, /source <\(e completion bash\)/);
});

test('ensureShellRcEntry: is idempotent - a second call reports already-configured', () => {
  const home = tempHome();
  ensureShellRcEntry('zsh', home);
  const before = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
  const second = ensureShellRcEntry('zsh', home);
  assert.equal(second.status, 'already-configured');
  const after = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
  assert.equal(before, after);
});

test('ensureShellRcEntry: preserves existing rc content and creates parent dirs for fish', () => {
  const home = tempHome();
  const result = ensureShellRcEntry('fish', home);
  assert.equal(result.status, 'added');
  assert.equal(
    (result as { file: string }).file,
    path.join(home, '.config', 'fish', 'config.fish')
  );
  assert.ok(fs.existsSync(path.join(home, '.config', 'fish', 'config.fish')));
});

test('ensureShellRcEntry: appends after existing content instead of clobbering it', () => {
  const home = tempHome();
  fs.writeFileSync(path.join(home, '.bashrc'), 'export FOO=bar\n');
  ensureShellRcEntry('bash', home);
  const content = fs.readFileSync(path.join(home, '.bashrc'), 'utf8');
  assert.match(content, /^export FOO=bar/);
  assert.match(content, /# >>> e shell completion >>>/);
});

test('ensureShellRcEntry: reports powershell as unsupported without touching disk', () => {
  const home = tempHome();
  const result = ensureShellRcEntry('powershell', home);
  assert.equal(result.status, 'unsupported');
  assert.deepEqual(fs.readdirSync(home), []);
});
