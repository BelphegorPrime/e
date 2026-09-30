import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  anthropicEvents,
  createCursor,
  lastInputText,
  openAiChunks,
  openAiCompletion,
  responsesEvents,
  responsesObject,
  userText,
  startStub,
} from './stub-model.mjs';

test('lastInputText / userText: newest input and the task', () => {
  const body = {
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'TASK one' }] },
      { role: 'assistant', content: 'x' },
      { role: 'tool', content: 'tool said hi' },
    ],
  };
  assert.equal(lastInputText(body), 'tool said hi');
  assert.equal(userText(body), 'TASK one');
  assert.equal(lastInputText({}), '');
  // Responses API input items; Codex opens with a context message of its own.
  const responses = {
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context/>' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'TASK two' }],
      },
      { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'exit 0' },
    ],
  };
  assert.equal(lastInputText(responses), 'exit 0');
  assert.match(userText(responses), /TASK two/);
  assert.equal(lastInputText({ input: 'plain' }), 'plain');
});

test('createCursor: task-filtered turns never get lost to another conversation', () => {
  const cursor = createCursor({
    turns: [
      { task: 'PARENT', text: 'p1' },
      { task: 'SIB', text: 's1' },
      { task: 'PARENT', text: 'p2' },
      { match: 'ready', text: 'm' },
    ],
    final: 'fin',
  });
  const tools = [{ type: 'function', function: { name: 'bash' } }];
  const parent = { tools, messages: [{ role: 'user', content: 'PARENT go' }] };
  const sib = { tools, messages: [{ role: 'user', content: 'SIB go' }] };
  assert.equal(cursor.next(parent).text, 'p1');
  assert.equal(cursor.next(parent).text, 'p2');
  assert.equal(cursor.next(sib).text, 's1');
  assert.equal(cursor.next(sib).text, 'fin');
  assert.equal(
    cursor.next({ tools, messages: [{ role: 'user', content: 'now ready' }] })
      .text,
    'm'
  );
  assert.equal(cursor.served, 4);
});

test('createCursor: side requests without tools use no turn; tool turns need the tool offered', () => {
  const cursor = createCursor({
    turns: [
      { tool: 'bash', args: {} },
      { aux: true, text: 'my title' },
      { text: 'after' },
    ],
    final: 'fin',
    aux: 'x',
  });
  const task = { messages: [{ role: 'user', content: 'go' }] };
  const bash = { ...task, tools: [{ name: 'bash' }] };
  const other = { ...task, tools: [{ name: 'exec_command' }] };
  assert.equal(cursor.next(task).text, 'my title'); // the aux turn
  assert.equal(cursor.next(task).text, 'x'); // no aux turn left: the default
  assert.equal(cursor.next(other).text, 'after'); // bash is not offered
  assert.equal(cursor.next(bash).tool, 'bash');
  assert.equal(cursor.next(bash).text, 'fin');
});

test('openAiCompletion / openAiChunks: tool calls in both shapes', () => {
  const turn = { tool: 'bash', args: { command: 'ls' } };
  const done = openAiCompletion(turn, 'stub', 7);
  assert.equal(done.choices[0].finish_reason, 'tool_calls');
  assert.equal(
    done.choices[0].message.tool_calls[0].function.arguments,
    '{"command":"ls"}'
  );
  const chunks = openAiChunks({ text: 'hi' }, 'stub', 1);
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  assert.ok(chunks.some(c => c.choices[0].delta.content === 'hi'));
});

test('anthropicEvents: a tool_use block streamed as input_json_delta', () => {
  const events = anthropicEvents(
    { tool: 'Bash', args: { command: 'ls' } },
    'm',
    1
  );
  const names = events.map(([e]) => e);
  assert.equal(names[0], 'message_start');
  assert.equal(names.at(-1), 'message_stop');
  const delta = events.find(([e]) => e === 'content_block_delta')[1];
  assert.equal(delta.delta.partial_json, '{"command":"ls"}');
  const stop = events.find(([e]) => e === 'message_delta')[1];
  assert.equal(stop.delta.stop_reason, 'tool_use');
});

test('responsesObject / responsesEvents: function calls for the Responses API', () => {
  const turn = { text: 'on it', tool: 'shell', args: { command: ['ls'] } };
  const done = responsesObject(turn, 'stub', 3);
  assert.deepEqual(
    done.output.map(i => i.type),
    ['message', 'function_call']
  );
  assert.equal(done.output[1].arguments, '{"command":["ls"]}');
  const events = responsesEvents(turn, 'stub', 3);
  const names = events.map(([e]) => e);
  assert.equal(names[0], 'response.created');
  assert.equal(names.at(-1), 'response.completed');
  assert.equal(names.filter(n => n === 'response.output_item.done').length, 2);
  assert.deepEqual(
    events.map(([, d]) => d.sequence_number),
    events.map((_, i) => i)
  );
  assert.equal(events.at(-1)[1].response.status, 'completed');
});

const request = (port, method, p, body) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: p,
        headers: { 'content-type': 'application/json' },
      },
      res => {
        let data = '';
        res.on('data', d => (data += d));
        res.on('end', () => resolve({ status: res.statusCode, data }));
      }
    );
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });

test('startStub: serves the script, streams, and logs every request', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-model-test-'));
  const logFile = path.join(dir, 'model.jsonl');
  const server = await startStub({
    script: { turns: [{ text: 'first' }], final: 'fin', aux: 'side' },
    logFile,
    host: '127.0.0.1',
  });
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { port } = server.address();

  const models = await request(port, 'GET', '/v1/models');
  assert.equal(JSON.parse(models.data).data[0].id, 'stub');

  const one = await request(port, 'POST', '/v1/chat/completions', {
    model: 'stub',
    tools: [{ type: 'function', function: { name: 'bash' } }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(JSON.parse(one.data).choices[0].message.content, 'first');

  const two = await request(port, 'POST', '/v1/messages', {
    model: 'stub',
    stream: true,
    tools: [{ name: 'Bash' }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.match(two.data, /event: message_start/);
  assert.match(two.data, /"text":"fin"/);

  const three = await request(port, 'POST', '/v1/responses', {
    model: 'stub',
    stream: true,
    input: [{ role: 'user', content: 'hi' }],
  });
  assert.match(three.data, /event: response.completed/);

  const missing = await request(port, 'POST', '/v1/embeddings', {});
  assert.equal(missing.status, 404);

  const log = fs
    .readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l));
  const served = log.filter(e => e.dir === 'req' && e.seq !== undefined);
  assert.deepEqual(
    served.map(e => e.serves.text),
    ['first', 'fin', 'side']
  );
});

test('startStub --upstream: forwards and records the reply', async t => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ via: req.url }));
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-model-test-'));
  const logFile = path.join(dir, 'model.jsonl');
  const server = await startStub({
    script: { turns: [], final: 'x' },
    logFile,
    host: '127.0.0.1',
    upstream: `http://127.0.0.1:${upstream.address().port}`,
  });
  t.after(() => {
    server.close();
    upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const res = await request(
    server.address().port,
    'POST',
    '/v1/chat/completions',
    {
      model: 'm',
    }
  );
  assert.deepEqual(JSON.parse(res.data), { via: '/v1/chat/completions' });
  const log = fs
    .readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l));
  assert.equal(log[0].upstream.startsWith('http://127.0.0.1:'), true);
  assert.match(log.find(e => e.dir === 'res').raw, /via/);
});
