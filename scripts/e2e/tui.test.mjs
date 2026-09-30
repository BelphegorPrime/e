import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  keyBytes,
  parseKeys,
  runTui,
  screenText,
  shellQuote,
  stripAnsi,
} from './tui.mjs';

const require = createRequire(import.meta.url);

test('keyBytes: named keys and ctrl-<letter>, unknown names refused', () => {
  assert.equal(keyBytes('enter'), '\r');
  assert.equal(keyBytes('Up'), '\x1b[A');
  assert.equal(keyBytes('ctrl-c'), '\x03');
  assert.equal(keyBytes('ctrl-d'), '\x04');
  assert.equal(keyBytes('f2'), '\x1bOQ');
  assert.throws(() => keyBytes('hyper-x'), /unknown key/);
});

test('parseKeys: an array or { steps }, every step checked up front', () => {
  assert.equal(parseKeys([{ wait: 'x' }]).length, 1);
  assert.equal(parseKeys({ steps: [{ key: 'enter' }] }).length, 1);
  assert.throws(() => parseKeys({}), /array of steps/);
  assert.throws(() => parseKeys([{ nope: 1 }]), /step 1: needs one of/);
  assert.throws(() => parseKeys([{ key: 'hyper-x' }]), /unknown key/);
  assert.throws(() => parseKeys([{ wait: '(' }]), /Invalid regular expression/);
});

test('shellQuote: plain words stay, the rest is single-quoted', () => {
  assert.equal(
    shellQuote(['node', '/a/b.js', 'spawn', "it's a prompt"]),
    `node /a/b.js spawn 'it'\\''s a prompt'`
  );
});

test('stripAnsi: colors, cursor moves, OSC titles and control bytes go', () => {
  assert.equal(
    stripAnsi('\x1b]0;title\x07\x1b[31mred\x1b[0m \x1b[2J\x1b[Hok\x07'),
    'red ok'
  );
});

test('screenText: the viewport, trailing blank lines dropped', async () => {
  const { Terminal } = require('@xterm/headless');
  const term = new Terminal({ cols: 10, rows: 4, allowProposedApi: true });
  await new Promise(r => term.write('a\r\n\x1b[1mb\x1b[0m\r\n', r));
  assert.equal(screenText(term), 'a\nb');
  term.dispose();
});

test('runTui: waits for the screen, types paced input, records snapshots and the exit code', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let text = '';
  const result = await runTui({
    argv: [
      'sh',
      '-c',
      'stty size; printf "name? "; read n; echo "hi $n"; read x; exit 7',
    ],
    cwd: dir,
    env: process.env,
    cols: 90,
    rows: 20,
    steps: [
      { wait: 'name\\?', timeout: 10 },
      { send: 'e2e', key: 'enter' },
      { wait: 'hi e2e', timeout: 10 },
      { snapshot: 'greeted' },
      { key: 'enter' },
      { exit: 10 },
    ],
    stepDir: dir,
    onText: s => (text += s),
    paceMs: 50,
  });
  assert.equal(result.failed, false);
  assert.equal(result.exit.code, 7);
  assert.match(text, /20 90/); // the pty was sized before the command started
  assert.match(result.final, /hi e2e/);
  const snap = result.steps.find(s => s.snapshot === 'greeted').file;
  assert.match(fs.readFileSync(path.join(dir, 'tui', snap), 'utf8'), /hi e2e/);
  assert.ok(fs.statSync(path.join(dir, 'tty.raw')).size > 0);
  const journal = fs
    .readFileSync(path.join(dir, 'tui', 'steps.jsonl'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(journal.length, 6);
});

test('runTui: stable waits for the screen to stop redrawing, not just to match', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await runTui({
    argv: [
      'sh',
      '-c',
      'echo ready; for i in 1 2 3 4; do sleep 0.3; echo tick $i; done; read x',
    ],
    cwd: dir,
    env: process.env,
    steps: [
      { wait: 'ready', stable: 0.8, timeout: 10 },
      { key: 'enter' },
      { exit: 10 },
    ],
    stepDir: dir,
    paceMs: 10,
  });
  assert.equal(result.failed, false);
  const snap = fs.readFileSync(
    path.join(dir, 'tui', result.steps[0].file),
    'utf8'
  );
  // Matched at once, but held until the ticking was over.
  assert.match(snap, /tick 4/);
});

test('runTui: a wait that never matches fails the script and ends the command', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await runTui({
    argv: ['sh', '-c', 'echo ready; sleep 60'],
    cwd: dir,
    env: process.env,
    steps: [{ wait: 'never shown', timeout: 1 }, { key: 'enter' }],
    stepDir: dir,
    paceMs: 10,
  });
  assert.equal(result.failed, true);
  assert.equal(result.steps.length, 1);
  assert.match(result.steps[0].error, /timed out/);
  assert.match(result.steps[0].file, /FAILED/);
  // Ctrl-C ended it: the command did not run its 60 seconds.
  assert.notEqual(result.exit.code, 0);
});
