import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { downloadModel } from './command.js';
import { log } from '../utils/log.js';

// The download subcommand is a thin shell over two external surfaces (curl for
// llama.cpp, `docker exec ... ollama pull` for Ollama) plus an informational
// pass-through for vLLM, which has no pull command. We inject a fake spawn
// function that records the command line so we can assert the correct outcome
// without spawning real processes; the CLI wiring (`e <runtime> download
// <model>`) is exercised in main.test.

function stubSpawn(calls: Array<{ file: string; args: string[] }>) {
  return (file: string, args: readonly string[], _options?: unknown) => {
    calls.push({ file, args: [...args] });
    return {
      status: 0,
      error: undefined,
      signal: null,
      stdout: '',
      stderr: '',
    };
  };
}

test('downloadModel llamacpp: POSTs the model to llama.cpp model registry', () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  downloadModel('llamacpp', 'org/model:Q4_K_M', stubSpawn(calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'curl');
  assert.ok(calls[0].args.includes('-X'));
  assert.ok(calls[0].args.includes('POST'));
  assert.deepEqual(
    calls[0].args.filter(a => a.startsWith('http://127.0.0.1:9931')),
    ['http://127.0.0.1:9931/models']
  );
  assert.ok(calls[0].args.includes('{"model":"org/model:Q4_K_M"}'));
});

test('downloadModel llamacpp: a failing curl surfaces an actionable error', () => {
  const failingSpawn = (
    _file: string,
    _args: readonly string[],
    _options?: unknown
  ) => ({
    status: 1,
    error: undefined,
    signal: null,
    stdout: '',
    stderr: '',
  });
  assert.throws(
    () => downloadModel('llamacpp', 'org/model', failingSpawn),
    /llama.cpp rejected the model download/
  );
});

test('downloadModel ollama: pulls through docker exec into the ollama container', () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  downloadModel('ollama', 'gemma:e2b', stubSpawn(calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'docker');
  assert.deepEqual(calls[0].args, [
    'exec',
    'ollama',
    'ollama',
    'pull',
    'gemma:e2b',
  ]);
});

test('downloadModel ollama: a failing pull surfaces an actionable error', () => {
  const failingSpawn = (
    _file: string,
    _args: readonly string[],
    _options?: unknown
  ) => ({
    status: 2,
    error: undefined,
    signal: null,
    stdout: '',
    stderr: '',
  });
  assert.throws(
    () => downloadModel('ollama', 'gemma:e2b', failingSpawn),
    /ollama pull failed/
  );
});

test('downloadModel vllm: reports the first-load handoff without spawning anything', () => {
  const calls: Array<unknown> = [];
  const fakeSpawn = (
    _file: string,
    _args: readonly string[],
    _options?: unknown
  ) => {
    calls.push({ _file, _args });
    return {
      status: 0,
      error: undefined,
      signal: null,
      stdout: '',
      stderr: '',
    };
  };
  let infoMessage = '';
  mock.method(log, 'info', (msg: string) => (infoMessage = msg));
  downloadModel('vllm', 'Qwen/Qwen2.5-7B-Instruct', fakeSpawn);
  assert.equal(calls.length, 0);
  assert.match(
    infoMessage,
    /vLLM downloads "Qwen\/Qwen2.5-7B-Instruct" on first request/
  );
  mock.reset();
});
