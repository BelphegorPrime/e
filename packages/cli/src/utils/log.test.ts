import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { log } from './log';

// Tests run under `node --test`, where stdout/stderr are not TTYs, so
// `styleText` emits plain text — output is asserted without ANSI escapes.
// We capture by swapping each stream's `write` for the duration of a test.

let out: string[];
let err: string[];
let restore: () => void;

beforeEach(() => {
  out = [];
  err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  restore = () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  };
});

afterEach(() => restore());

test('info writes a plain line to stdout with a trailing newline', () => {
  log.info('hello');
  assert.deepEqual(out, ['hello\n']);
  assert.deepEqual(err, []);
});

test('success and command go to stdout; error and warn go to stderr', () => {
  log.success('done');
  log.command('> docker run');
  log.error('boom');
  log.warn('careful');
  assert.deepEqual(out, ['\x1B[32mdone\x1B[39m\n', '\x1B[34m> docker run\x1B[39m\n']);
  assert.deepEqual(err, ['\x1B[31mboom\x1B[39m\n', '\x1B[33mcareful\x1B[39m\n']);
});

test('rest args format like console (specifiers and joins)', () => {
  log.info('%s=%d', 'count', 3);
  log.info('a', 'b', 'c');
  assert.deepEqual(out, ['count=3\n', 'a b c\n']);
});

test('no args writes just a blank line', () => {
  log.info();
  assert.deepEqual(out, ['\n']);
});
