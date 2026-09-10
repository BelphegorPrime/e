import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// We test the CLI by running it as a subprocess against a temp dir.
function runE(...args: string[]): {
  stdout: string;
  stderr: string;
  code: number;
} {
  const result = spawnSync('node', ['dist/index.js', ...args], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? 1,
  };
}

test('e lint --help prints usage', () => {
  const { stdout, code } = runE('lint', '--help');
  assert.equal(code, 0);
  assert.ok(stdout.includes('Initialize linting and formatting gates'));
});

test('e lint runs without crashing when prek is absent', () => {
  // This test verifies the command is wired; prek availability is checked
  // at runtime. In CI without prek, it should error with a clear message.
  const { stderr, code } = runE('lint');
  // Either prek is present (code 0) or it prints a clear error (code 1).
  if (code === 1) {
    assert.ok(stderr.includes('prek') || stderr.includes('not found'));
  }
});
