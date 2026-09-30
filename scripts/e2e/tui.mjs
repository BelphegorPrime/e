// Remote control of an interactive `e` command (a harness TUI, `e init`'s
// wizard) for the e2e tracer: the command runs under a pseudo-terminal
// (util-linux `script`), a headless xterm renders what it draws, and a keys
// script drives it - waiting for text on the screen, typing, pressing keys,
// taking screen snapshots. See docs/agents/e2e.md, "Driving a TUI".
//
// A keys script is a JSON array of steps (or { "steps": [...] }):
//   { "wait": "regex", "timeout": 120 }   until the screen matches (seconds)
//   { "wait": "regex", "stable": 3 }      ... and then has not redrawn for 3 s:
//                                         a TUI done starting up, not starting
//   { "send": "text" }                    raw input, no Enter
//   { "key": "enter" }                    a named key (KEYS below)
//   { "send": "hi", "key": "enter" }      both, in that order
// Every send and key is followed by a pause (`paceMs`, default 250 ms): a
// burst of text plus Enter reads as a paste to most TUIs, not as a submit.
//   { "sleep": 2 }                        seconds
//   { "snapshot": "name" }                screen text into tui/NN-name.txt
//   { "exit": 60 }                        until the command exits (seconds)
// A failed `wait` or `exit` snapshots the screen and stops the script; the
// command then gets Ctrl-C, then SIGTERM (a pty hangup), SIGKILL last.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Named keys a step may press. */
export const KEYS = {
  enter: '\r',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  esc: '\x1b',
  backspace: '\x7f',
  space: ' ',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  delete: '\x1b[3~',
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~',
};

/** The bytes a key name stands for: KEYS, or `ctrl-<letter>`. */
export function keyBytes(name) {
  const key = String(name).toLowerCase();
  if (KEYS[key] !== undefined) return KEYS[key];
  const ctrl = key.match(/^ctrl-([a-z])$/);
  if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
  throw new Error(
    `unknown key "${name}" (known: ${Object.keys(KEYS).join(', ')}, ctrl-<letter>)`
  );
}

/** A keys script as a list of steps, validated. */
export function parseKeys(raw) {
  const steps = Array.isArray(raw) ? raw : raw?.steps;
  if (!Array.isArray(steps))
    throw new Error('keys script: an array of steps, or { "steps": [...] }');
  steps.forEach((s, i) => {
    const kinds = ['wait', 'send', 'key', 'sleep', 'snapshot', 'exit'].filter(
      k => s[k] !== undefined
    );
    if (kinds.length === 0)
      throw new Error(
        `keys step ${i + 1}: needs one of wait, send, key, sleep, snapshot, exit`
      );
    if (s.key !== undefined) keyBytes(s.key);
    if (s.wait !== undefined) new RegExp(s.wait, s.flags);
  });
  return steps;
}

/** One word per argument, quoted for `sh -c`. */
export function shellQuote(args) {
  return args
    .map(a =>
      /^[A-Za-z0-9_@%+=:,./-]+$/.test(a)
        ? a
        : `'${String(a).replace(/'/g, `'\\''`)}'`
    )
    .join(' ');
}

/** Terminal output without escape sequences, for the line log. */
/* eslint-disable no-control-regex -- matching terminal control bytes is the point */
export function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[=>78DEHMNOc]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
/* eslint-enable no-control-regex */

/** What a headless terminal shows in its viewport, trailing blank lines dropped. */
export function screenText(term) {
  const buf = term.buffer.active;
  const lines = [];
  for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) {
    lines.push(buf.getLine(y)?.translateToString(true) ?? '');
  }
  while (lines.length && lines.at(-1).trim() === '') lines.pop();
  return lines.join('\n');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Runs `argv` under a pseudo-terminal of `cols` x `rows` and plays `steps`
 * against it. Resolves once the command exited, with its exit code and what
 * each step did. Writes `tty.raw` and `tui/` into `stepDir`; `onText` gets the
 * escape-stripped output as it arrives (for combined.log).
 */
export async function runTui({
  argv,
  cwd,
  env,
  cols = 120,
  rows = 40,
  steps,
  stepDir,
  onText,
  settleMs = 30000,
  paceMs = 250,
}) {
  const { Terminal } = require('@xterm/headless');
  const term = new Terminal({
    cols,
    rows,
    allowProposedApi: true,
    scrollback: 5000,
  });
  const tuiDir = path.join(stepDir, 'tui');
  fs.mkdirSync(tuiDir, { recursive: true });
  const raw = fs.createWriteStream(path.join(stepDir, 'tty.raw'));
  const journal = fs.createWriteStream(path.join(tuiDir, 'steps.jsonl'));
  const started = Date.now();
  const note = entry =>
    journal.write(
      JSON.stringify({ t: (Date.now() - started) / 1000, ...entry }) + '\n'
    );

  // `stty` sizes the pty before the command starts, so the TUI (and the
  // container's tty, which docker sizes from ours) lays out for cols x rows.
  const inner = `stty cols ${cols} rows ${rows}; exec ${shellQuote(argv)}`;
  const child = spawn('script', ['-q', '-f', '-e', '-c', inner, '/dev/null'], {
    cwd,
    env: {
      ...env,
      TERM: 'xterm-256color',
      COLUMNS: String(cols),
      LINES: String(rows),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let pending = Promise.resolve();
  const feed = chunk => {
    raw.write(chunk);
    const s = chunk.toString('utf8');
    pending = pending.then(() => new Promise(r => term.write(s, r)));
    onText?.(stripAnsi(s));
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  const exited = new Promise(resolve =>
    child.on('exit', (code, signal) => resolve({ code, signal }))
  );
  let exit;
  exited.then(e => (exit = e));

  let snapCount = 0;
  const snapshot = async name => {
    await pending;
    const file = `${String(++snapCount).padStart(2, '0')}-${String(name).replace(/[^A-Za-z0-9._-]+/g, '_')}.txt`;
    const text = screenText(term);
    fs.writeFileSync(path.join(tuiDir, file), text + '\n');
    return file;
  };

  const results = [];
  let failed = false;
  for (const [i, step] of steps.entries()) {
    const result = { step: i + 1, ...step, ok: true };
    if (step.wait !== undefined) {
      const re = new RegExp(step.wait, step.flags);
      const deadline = Date.now() + (step.timeout ?? 120) * 1000;
      const stableMs = (step.stable ?? 0) * 1000;
      let last;
      let since = Date.now();
      for (;;) {
        await pending;
        const screen = screenText(term);
        if (screen !== last) {
          last = screen;
          since = Date.now();
        }
        // `stable`: matched, and nothing has redrawn for that long - the TUI
        // finished starting up (or answering) rather than just began.
        if (re.test(screen) && Date.now() - since >= stableMs) break;
        if (exit || Date.now() > deadline) {
          result.ok = false;
          result.error = exit
            ? `command exited (${exit.code}) before the screen matched`
            : 'timed out';
          break;
        }
        await sleep(150);
      }
      result.file = await snapshot(
        result.ok ? `wait-${i + 1}` : `wait-${i + 1}-FAILED`
      );
    }
    // Input is paced: TUIs read a burst of bytes as a paste, in which an
    // Enter right behind the text is a newline rather than a submit.
    if (step.send !== undefined && !exit) {
      child.stdin.write(step.send);
      await sleep(paceMs);
    }
    if (step.key !== undefined && !exit) {
      child.stdin.write(keyBytes(step.key));
      await sleep(paceMs);
    }
    if (step.sleep !== undefined) await sleep(step.sleep * 1000);
    if (step.snapshot !== undefined)
      result.file = await snapshot(step.snapshot);
    if (step.exit !== undefined) {
      const done = await Promise.race([
        exited,
        sleep(step.exit * 1000).then(() => undefined),
      ]);
      if (!done) {
        result.ok = false;
        result.error = 'still running';
        result.file = await snapshot(`exit-${i + 1}-FAILED`);
      }
    }
    result.at = (Date.now() - started) / 1000;
    note(result);
    results.push(result);
    if (!result.ok) {
      failed = true;
      break;
    }
  }

  // The script is done: give the command a moment to end on its own, then
  // Ctrl-C it, then hang up the pty, and kill it only as a last resort (a
  // killed `e` cannot tear its run down).
  if (!exit) {
    const done = await Promise.race([
      exited,
      sleep(failed ? 1000 : settleMs).then(() => undefined),
    ]);
    if (!done) {
      note({
        action: 'ctrl-c',
        reason: failed ? 'script failed' : 'still running after the script',
      });
      child.stdin.write('\x03');
      const stopped = await Promise.race([
        exited,
        sleep(10000).then(() => undefined),
      ]);
      if (!stopped) {
        // SIGTERM ends `script`, which hangs up the pty: `e` treats that as a
        // cancel and tears its run down (ADR-0015).
        note({ action: 'SIGTERM', reason: 'Ctrl-C did not end it' });
        child.kill('SIGTERM');
        const ended = await Promise.race([
          exited,
          sleep(30000).then(() => undefined),
        ]);
        if (!ended) {
          note({ action: 'SIGKILL', reason: 'SIGTERM did not end it' });
          child.kill('SIGKILL');
        }
      }
    }
  }
  const final = await exited;
  await pending;
  const finalScreen = screenText(term);
  fs.writeFileSync(path.join(tuiDir, 'final.txt'), finalScreen + '\n');
  await Promise.all([raw, journal].map(f => new Promise(r => f.end(r))));
  term.dispose();
  return { exit: final, steps: results, failed, final: finalScreen };
}
