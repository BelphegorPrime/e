import { test, beforeEach, afterEach } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import assert from 'node:assert/strict';
import { log } from './log.js';

// Capture each stream's writes. Color availability varies with test runner
// environment, so stream-routing assertions strip ANSI escape sequences.

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
  assert.deepEqual(out.map(stripVTControlCharacters), [
    'done\n',
    '> docker run\n',
  ]);
  assert.deepEqual(err.map(stripVTControlCharacters), ['boom\n', 'careful\n']);
});

test('rest args format like console (specifiers and joins)', () => {
  log.info('%s=%d', 'count', 3);
  log.info('a', 'b', 'c');
  assert.deepEqual(out, ['count=3\n', 'a b c\n']);
});

test('debug writes to stdout only if verbose enabled', () => {
  const origVerbose = process.env.VERBOSE;
  process.env.VERBOSE = 'true';
  try {
    log.debug('hidden');
    assert.deepEqual(out, ['hidden\n']);
  } finally {
    process.env.VERBOSE = origVerbose;
  }
});

test('debug silent when verbose disabled', () => {
  const origVerbose = process.env.VERBOSE;
  process.env.VERBOSE = 'false';
  try {
    log.debug('hidden');
    assert.deepEqual(out, []);
  } finally {
    process.env.VERBOSE = origVerbose;
  }
});

test('debug is hidden unless VERBOSE is set', () => {
  delete process.env.VERBOSE;
  log.debug('hidden detail');
  assert.deepEqual(out, []);

  process.env.VERBOSE = 'true';
  log.debug('visible detail');
  assert.deepEqual(out, ['visible detail\n']);

  delete process.env.VERBOSE;
});

test('debug writes nothing unless verbose is enabled', () => {
  const previous = process.env.VERBOSE;
  try {
    delete process.env.VERBOSE;
    log.debug('secret');
    assert.deepEqual(out, []);

    process.env.VERBOSE = 'true';
    log.debug('secret');
    assert.deepEqual(out, ['secret\n']);
  } finally {
    if (previous === undefined) delete process.env.VERBOSE;
    else process.env.VERBOSE = previous;
  }
});
