import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Env, env } from './env.js';

const VARS = ['LOCAL_LLAMA_URL', 'SHOULD_WRITE_LOG_FILE', Env.SERVE_DETACHED_VAR] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map(name => [name, process.env[name]]));
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

test('localLlamaUrl falls back to the default router URL when unset', () => {
  delete process.env.LOCAL_LLAMA_URL;
  assert.equal(env.localLlamaUrl, 'http://127.0.0.1:9931');
});

test('localLlamaUrl reflects LOCAL_LLAMA_URL when set', () => {
  process.env.LOCAL_LLAMA_URL = 'http://example.test:1234';
  assert.equal(env.localLlamaUrl, 'http://example.test:1234');
});

test('shouldWriteLogFile is true only for the literal string "true"', () => {
  process.env.SHOULD_WRITE_LOG_FILE = 'true';
  assert.equal(env.shouldWriteLogFile, true);
  process.env.SHOULD_WRITE_LOG_FILE = 'yes';
  assert.equal(env.shouldWriteLogFile, false);
  delete process.env.SHOULD_WRITE_LOG_FILE;
  assert.equal(env.shouldWriteLogFile, false);
});

test('serveDetached reflects the marker variable', () => {
  delete process.env[Env.SERVE_DETACHED_VAR];
  assert.equal(env.serveDetached, false);
  process.env[Env.SERVE_DETACHED_VAR] = '1';
  assert.equal(env.serveDetached, true);
});

test('withServeDetached copies the base env and sets the marker without mutating it', () => {
  const base = { FOO: 'bar' };
  const result = env.withServeDetached(base);
  assert.equal(result.FOO, 'bar');
  assert.equal(result[Env.SERVE_DETACHED_VAR], '1');
  assert.equal(Env.SERVE_DETACHED_VAR in base, false);
});
