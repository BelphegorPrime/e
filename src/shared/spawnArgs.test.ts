import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPAWN_COMMAND, SPAWN_FLAGS, spawnArgs } from './spawnArgs.js';

test('a sibling run is one-shot: the prompt goes last, behind --', () => {
  assert.deepEqual(spawnArgs({ agent: 'researcher', prompt: 'look into X' }), [
    'spawn',
    'researcher',
    '--',
    'look into X',
  ]);
});

test('a prompt that starts with a dash is text, not a flag', () => {
  const args = spawnArgs({ agent: 'pi', prompt: '--help me instead' });
  assert.equal(args[args.length - 2], '--');
  assert.equal(args[args.length - 1], '--help me instead');
});

test('no prompt means no --: the harness TUI opens', () => {
  // What the browser terminal wants, and what a sibling must never get.
  const args = spawnArgs({ agent: 'pi', name: 'fix-login' });
  assert.deepEqual(args, ['spawn', 'pi', '--name', 'fix-login']);
  assert.ok(!args.includes('--'));
});

test('skills and MCP servers each get their own flag, in order', () => {
  assert.deepEqual(
    spawnArgs({
      agent: 'pi',
      name: 'slug',
      skills: ['spawn-brother', 'research'],
      mcp: ['everything', 'searxng'],
    }),
    [
      'spawn',
      'pi',
      '--name',
      'slug',
      '--skill',
      'spawn-brother',
      '--skill',
      'research',
      '--mcp',
      'everything',
      '--mcp',
      'searxng',
    ]
  );
});

test('passthrough arguments arrive verbatim, before the prompt', () => {
  assert.deepEqual(
    spawnArgs({
      agent: 'pi',
      prompt: 'go',
      passthrough: ['--dir', '/repo', '--env-file', '/a.env'],
    }),
    ['spawn', 'pi', '--dir', '/repo', '--env-file', '/a.env', '--', 'go']
  );
});

test('an absent field contributes nothing', () => {
  assert.deepEqual(spawnArgs({ agent: 'pi' }), ['spawn', 'pi']);
  assert.deepEqual(spawnArgs({ agent: 'pi', skills: [], mcp: [] }), [
    'spawn',
    'pi',
  ]);
});

test('the command and every flag come from the shared constants', () => {
  // This is the whole point of the module: `registerSpawnCommand` declares
  // itself from these same values, so a rename cannot land on one side only.
  // If this test has to be edited, every caller had to be edited too.
  assert.equal(SPAWN_COMMAND, 'spawn');
  assert.deepEqual(SPAWN_FLAGS, {
    name: '--name',
    skill: '--skill',
    mcp: '--mcp',
    envFile: '--env-file',
    dir: '--dir',
    runtime: '--runtime',
    rebuild: '--rebuild',
    keepWorktree: '--keep-worktree',
  });
});
