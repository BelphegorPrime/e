import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  completionSourceCommand,
  ensureShellRcEntry,
  powerShellProfilePath,
} from './shellRc.js';

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

test('ensureShellRcEntry: powershell without a locatable $PROFILE is unsupported and touches nothing', () => {
  const home = tempHome();
  const result = ensureShellRcEntry('powershell', home, () => undefined);
  assert.equal(result.status, 'unsupported');
  assert.deepEqual(fs.readdirSync(home), []);
});

test('ensureShellRcEntry: powershell writes the guarded block into the resolved $PROFILE', () => {
  const home = tempHome();
  const profile = path.join(
    home,
    'Documents',
    'PowerShell',
    'Microsoft.PowerShell_profile.ps1'
  );
  const result = ensureShellRcEntry('powershell', home, () => profile);
  assert.equal(result.status, 'added');
  assert.equal((result as { file: string }).file, profile);
  const content = fs.readFileSync(profile, 'utf8');
  assert.match(content, /# >>> e shell completion >>>/);
  assert.match(
    content,
    /e completion powershell \| Out-String \| Invoke-Expression/
  );
  const second = ensureShellRcEntry('powershell', home, () => profile);
  assert.equal(second.status, 'already-configured');
});

test('powerShellProfilePath: asks pwsh, then powershell, for an absolute $PROFILE', () => {
  const asked: string[] = [];
  const answers: Record<string, { status: number; stdout: string }> = {
    pwsh: { status: 1, stdout: '' },
    powershell: {
      status: 0,
      stdout:
        'C:\\Users\\dev\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1\r\n',
    },
  };
  const spawn = (command: string, args: readonly string[]) => {
    asked.push(command);
    assert.deepEqual(args, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$PROFILE',
    ]);
    return answers[command];
  };
  const profile = powerShellProfilePath(spawn);
  assert.deepEqual(asked, ['pwsh', 'powershell']);
  // Windows drive paths are absolute on Windows only; on POSIX the probe
  // rejects them, which is the honest answer for a Windows-only file.
  if (process.platform === 'win32') {
    assert.equal(
      profile,
      'C:\\Users\\dev\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1'
    );
  } else {
    assert.equal(profile, undefined);
  }
});

test('powerShellProfilePath: a POSIX pwsh profile is accepted; a missing pwsh is undefined', () => {
  const posix = (command: string) =>
    command === 'pwsh'
      ? {
          status: 0,
          stdout:
            '/home/dev/.config/powershell/Microsoft.PowerShell_profile.ps1\n',
        }
      : { status: 1, stdout: '' };
  assert.equal(
    powerShellProfilePath(posix),
    '/home/dev/.config/powershell/Microsoft.PowerShell_profile.ps1'
  );
  const missing = () => ({
    status: null,
    error: new Error('ENOENT'),
    stdout: '',
  });
  assert.equal(powerShellProfilePath(missing), undefined);
});
