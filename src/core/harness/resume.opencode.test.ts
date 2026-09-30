import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARNESSES, harnessCapabilities } from './index.js';
import { renderDockerfile, SESSION_PARENT_LABEL } from './renderDockerfile.js';

const opencode = HARNESSES.opencode;
const SESSION_DIR = '/home/node/.local/share/opencode-session';

test('opencode resumeCommand continues the newest session one-shot, keeping --auto (ADR-0017)', () => {
  assert.deepEqual(opencode.resumeCommand!('go on', 'e/opus'), [
    'opencode',
    'run',
    '--auto',
    '--continue',
    '-m',
    'e/opus',
    'go on',
  ]);
  assert.deepEqual(opencode.resumeCommand!('go on'), [
    'opencode',
    'run',
    '--auto',
    '--continue',
    'go on',
  ]);
});

test('opencode resumeCommand without a prompt reopens the session in the TUI', () => {
  assert.deepEqual(opencode.resumeCommand!(undefined, 'e/opus'), [
    'opencode',
    '--continue',
    '-m',
    'e/opus',
  ]);
  assert.deepEqual(opencode.resumeCommand!(undefined), [
    'opencode',
    '--continue',
  ]);
});

test('opencode is never resumed with --share (that publishes the session)', () => {
  for (const argv of [
    opencode.resumeCommand!('go on', 'e/opus'),
    opencode.resumeCommand!(undefined),
  ]) {
    assert.ok(!argv.includes('--share'), argv.join(' '));
  }
});

test('opencode keeps its session db in a dir of its own, never beside auth.json', () => {
  assert.equal(opencode.sessionDir, SESSION_DIR);
  assert.ok(!opencode.sessionDir!.startsWith('/workspace'));
  // The default data dir holds auth.json and mcp-auth.json: not mounted.
  assert.notEqual(opencode.sessionDir, '/home/node/.local/share/opencode');
  assert.deepEqual(opencode.sessionEnv, [
    { name: 'OPENCODE_DB', value: `${SESSION_DIR}/opencode.db` },
  ]);
  assert.equal(harnessCapabilities(opencode).resume, true);
});

test("opencode's image creates the data home node-owned and says so in a label", () => {
  const dockerfile = renderDockerfile(opencode.dockerfile);
  const mkdir = dockerfile.indexOf('RUN mkdir -p /home/node/.local/share\n');
  const chown = dockerfile.indexOf('RUN chown -R node:node /home/node');
  assert.ok(mkdir > 0 && chown > mkdir, dockerfile);
  assert.match(
    dockerfile,
    new RegExp(`${SESSION_PARENT_LABEL}="/home/node/\\.local/share"`)
  );
});

test('a harness that needs no session parent renders no session label', () => {
  assert.doesNotMatch(
    renderDockerfile(HARNESSES.pi.dockerfile),
    new RegExp(SESSION_PARENT_LABEL)
  );
});
