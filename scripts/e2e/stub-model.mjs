#!/usr/bin/env node
// A scripted, OpenAI- and Anthropic-compatible model endpoint for end-to-end
// runs of `e`. The harness inside the run container talks to it like to any
// provider; every request and every reply lands in a JSONL log, so an agent
// testing `e` sees exactly what the harness sent (system prompt, tools, tool
// results) and what it got back.
//
// Wire formats: OpenAI chat-completions (pi, opencode), OpenAI Responses
// (Codex) and Anthropic messages (Claude Code), each streamed or not.
//
// The script is a JSON file: { "turns": [Turn, ...], "final": "text" }.
// Each request gets the first unused turn it is eligible for; once none is
// left it gets `final` (default "done"), so a harness always ends its loop.
// A Turn is one of:
//   { "text": "..." }                                  plain assistant answer
//   { "tool": "bash", "args": { "command": "ls" } }    one tool call
//   { "tools": [{ "tool": "...", "args": {...} }] }    several tool calls
// A request that offers no tools at all (a title or summary side request) gets
// `aux` (default "e2e") and uses no turn, unless a turn says "aux": true. A
// tool-call turn is served only to a request offering that tool.
// Turns may carry filters, so concurrent conversations each get their own:
//   "task": "substring"   only for a conversation with a user message (the
//                         run's prompt) containing it - parent vs. sibling
//   "match": "substring"  only when the newest user/tool message contains it
//
// Usage: node stub-model.mjs --script <file> --log <file> [--port 0] [--host 0.0.0.0]
//        node stub-model.mjs --upstream http://127.0.0.1:20128 --log <file>
//        (recording proxy: forwards everything, logs every request and reply)
// Prints one JSON line {"port":N} on stdout once listening.

import http from 'node:http';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

/** Loads a script file, or an empty script when no path is given. */
export function loadScript(file) {
  if (!file) return { turns: [], final: 'done', aux: 'e2e' };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    turns: raw.turns ?? [],
    final: raw.final ?? 'done',
    aux: raw.aux ?? 'e2e',
  };
}

/**
 * A request's conversation as one list: chat-completions and Anthropic
 * `messages`, or the Responses API's `input` items.
 */
function conversation(body) {
  if (Array.isArray(body?.messages)) return body.messages;
  if (Array.isArray(body?.input)) return body.input;
  if (typeof body?.input === 'string')
    return [{ role: 'user', content: body.input }];
  return [];
}

/** The text of the newest user or tool input of a chat, Anthropic or Responses body. */
export function lastInputText(body) {
  const items = conversation(body);
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i];
    if (m.type === 'function_call_output') return String(m.output ?? '');
    if (m.role !== 'user' && m.role !== 'tool') continue;
    return contentText(m.content);
  }
  return '';
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part =>
      typeof part === 'string'
        ? part
        : (part.text ?? contentText(part.content) ?? '')
    )
    .join('\n');
}

/**
 * Every user message's text: what a conversation is about. All of them, not
 * the first, because some harnesses (Codex) open with context messages of
 * their own before the run's prompt.
 */
export function userText(body) {
  return conversation(body)
    .filter(m => m.role === 'user')
    .map(m => contentText(m.content))
    .join('\n');
}

/**
 * The turn cursor: `next(body)` returns the first unused turn the request is
 * eligible for and marks it used. A turn with `task` is eligible only for a
 * conversation with a user message containing it, one with `match` only
 * when the newest user/tool message does; a turn with neither fits any
 * request. Turns are never skipped for good, so concurrent conversations (a
 * parent and its siblings) each get theirs.
 */
export function createCursor(script) {
  const used = script.turns.map(() => false);
  return {
    next(body) {
      const last = lastInputText(body);
      const task = userText(body);
      const offered = offeredTools(body);
      // A request offering no tools is a harness's side request (opencode
      // titles every session first): it gets `aux` and uses no turn, unless
      // a turn is marked `aux: true` for exactly that.
      const aux = offered.length === 0;
      for (let i = 0; i < script.turns.length; i++) {
        if (used[i]) continue;
        const turn = script.turns[i];
        if (Boolean(turn.aux) !== aux) continue;
        if (turn.task !== undefined && !task.includes(turn.task)) continue;
        if (turn.match !== undefined && !last.includes(turn.match)) continue;
        // A tool call goes only to a conversation that offers the tool.
        const calls = turn.tools ?? (turn.tool ? [turn] : []);
        if (!aux && calls.some(c => !offered.includes(c.tool))) continue;
        used[i] = true;
        return turn;
      }
      return { text: aux ? (script.aux ?? 'e2e') : script.final };
    },
    get served() {
      return used.filter(Boolean).length;
    },
  };
}

/** The tool names a request offers, in any of the three wire formats. */
export function offeredTools(body) {
  return (body?.tools ?? [])
    .map(t => t.function?.name ?? t.name)
    .filter(Boolean);
}

/** Normalizes a turn to { text, calls: [{ id, name, args }] }. */
export function normalizeTurn(turn, seq) {
  const calls = (turn.tools ?? (turn.tool ? [turn] : [])).map((c, i) => ({
    id: `call_${seq}_${i}`,
    name: c.tool,
    args: c.args ?? {},
  }));
  return { text: turn.text ?? '', calls };
}

/** An OpenAI chat-completions response object. */
export function openAiCompletion(turn, model, seq) {
  const { text, calls } = normalizeTurn(turn, seq);
  return {
    id: `chatcmpl-stub-${seq}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(calls.length
            ? {
                tool_calls: calls.map(c => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              }
            : {}),
        },
        finish_reason: calls.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/** The same response as OpenAI chat-completions SSE chunks (without `[DONE]`). */
export function openAiChunks(turn, model, seq) {
  const { text, calls } = normalizeTurn(turn, seq);
  const base = {
    id: `chatcmpl-stub-${seq}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
  };
  const chunk = (delta, finish = null, extra = {}) => ({
    ...base,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });
  const out = [chunk({ role: 'assistant', content: '' })];
  if (text) out.push(chunk({ content: text }));
  calls.forEach((c, i) =>
    out.push(
      chunk({
        tool_calls: [
          {
            index: i,
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          },
        ],
      })
    )
  );
  out.push(
    chunk({}, calls.length ? 'tool_calls' : 'stop', {
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  );
  return out;
}

/** An Anthropic messages response object. */
export function anthropicMessage(turn, model, seq) {
  const { text, calls } = normalizeTurn(turn, seq);
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const c of calls)
    content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
  return {
    id: `msg_stub_${seq}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: calls.length ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/** The same response as Anthropic SSE events: [event, data] pairs. */
export function anthropicEvents(turn, model, seq) {
  const msg = anthropicMessage(turn, model, seq);
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: { ...msg, content: [], stop_reason: null },
      },
    ],
  ];
  msg.content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push([
        'content_block_start',
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        },
      ]);
      events.push([
        'content_block_delta',
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        },
      ]);
    } else {
      events.push([
        'content_block_start',
        {
          type: 'content_block_start',
          index,
          content_block: { ...block, input: {} },
        },
      ]);
      events.push([
        'content_block_delta',
        {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(block.input),
          },
        },
      ]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push([
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: msg.stop_reason, stop_sequence: null },
      usage: { output_tokens: 1 },
    },
  ]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events;
}

/**
 * Forwards one request to `upstream` and pipes the reply back, teeing the reply
 * body (capped) into the log: the recording proxy of `--upstream` mode.
 */
async function proxy(upstream, req, raw, res, seq, logLine) {
  const target = new URL(req.url ?? '/', upstream);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  let reply;
  try {
    reply = await fetch(target, {
      method: req.method,
      headers,
      body: raw && req.method !== 'GET' ? raw : undefined,
    });
  } catch (error) {
    logLine({
      dir: 'res',
      seq,
      status: 502,
      error: String(error?.cause ?? error),
    });
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `stub proxy: ${error}` } }));
    return;
  }
  const outHeaders = {};
  reply.headers.forEach((v, k) => {
    if (
      !['content-encoding', 'content-length', 'transfer-encoding'].includes(k)
    )
      outHeaders[k] = v;
  });
  res.writeHead(reply.status, outHeaders);
  let captured = '';
  const CAP = 256 * 1024;
  if (reply.body) {
    const decoder = new TextDecoder();
    for await (const chunk of reply.body) {
      res.write(chunk);
      if (captured.length < CAP)
        captured += decoder.decode(chunk, { stream: true });
    }
  }
  res.end();
  logLine({
    dir: 'res',
    seq,
    status: reply.status,
    raw: captured.slice(0, CAP),
  });
}

/** The Responses API output items of a turn: a message and/or function calls. */
function responseItems(turn, seq) {
  const { text, calls } = normalizeTurn(turn, seq);
  const items = [];
  if (text)
    items.push({
      type: 'message',
      id: `msg_stub_${seq}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  for (const c of calls)
    items.push({
      type: 'function_call',
      id: `fc_${c.id}`,
      call_id: c.id,
      name: c.name,
      arguments: JSON.stringify(c.args),
      status: 'completed',
    });
  return items;
}

/** An OpenAI Responses API response object. */
export function responsesObject(turn, model, seq) {
  return {
    id: `resp_stub_${seq}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output: responseItems(turn, seq),
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
  };
}

/** The same response as Responses API SSE events: [event, data] pairs. */
export function responsesEvents(turn, model, seq) {
  const done = responsesObject(turn, model, seq);
  let n = 0;
  const ev = (type, data) => [type, { type, sequence_number: n++, ...data }];
  const events = [
    ev('response.created', {
      response: { ...done, status: 'in_progress', output: [] },
    }),
    ev('response.in_progress', {
      response: { ...done, status: 'in_progress', output: [] },
    }),
  ];
  done.output.forEach((item, output_index) => {
    if (item.type === 'message') {
      const text = item.content[0].text;
      events.push(
        ev('response.output_item.added', {
          output_index,
          item: { ...item, status: 'in_progress', content: [] },
        }),
        ev('response.content_part.added', {
          item_id: item.id,
          output_index,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }),
        ev('response.output_text.delta', {
          item_id: item.id,
          output_index,
          content_index: 0,
          delta: text,
        }),
        ev('response.output_text.done', {
          item_id: item.id,
          output_index,
          content_index: 0,
          text,
        }),
        ev('response.content_part.done', {
          item_id: item.id,
          output_index,
          content_index: 0,
          part: item.content[0],
        })
      );
    } else {
      events.push(
        ev('response.output_item.added', {
          output_index,
          item: { ...item, arguments: '', status: 'in_progress' },
        }),
        ev('response.function_call_arguments.delta', {
          item_id: item.id,
          output_index,
          delta: item.arguments,
        }),
        ev('response.function_call_arguments.done', {
          item_id: item.id,
          output_index,
          arguments: item.arguments,
        })
      );
    }
    events.push(ev('response.output_item.done', { output_index, item }));
  });
  events.push(ev('response.completed', { response: done }));
  return events;
}

/** Starts the stub; resolves to the listening server. */
export function startStub({
  script,
  logFile,
  port = 0,
  host = '0.0.0.0',
  upstream,
}) {
  const cursor = createCursor(script);
  let seq = 0;
  const logLine = entry => {
    if (logFile)
      fs.appendFileSync(
        logFile,
        JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n'
      );
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => (raw += d));
    req.on('end', () => {
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const url = new URL(req.url ?? '/', 'http://stub');
      const route = url.pathname.replace(/^\/v1/, '');
      const model = body?.model ?? 'stub';

      if (upstream) {
        seq++;
        logLine({
          dir: 'req',
          seq,
          method: req.method,
          path: url.pathname,
          body,
          upstream,
        });
        void proxy(upstream, req, raw, res, seq, logLine);
        return;
      }

      const reply = (status, payload) => {
        logLine({ dir: 'res', seq, status, body: payload });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.method === 'GET' && route === '/models') {
        logLine({ dir: 'req', method: req.method, path: url.pathname });
        return reply(200, {
          object: 'list',
          data: [{ id: 'stub', object: 'model', owned_by: 'e2e' }],
        });
      }
      if (
        req.method !== 'POST' ||
        !['/chat/completions', '/messages', '/responses'].includes(route)
      ) {
        logLine({ dir: 'req', method: req.method, path: url.pathname, body });
        return reply(404, { error: { message: `stub: no route ${route}` } });
      }

      seq++;
      const turn = cursor.next(body);
      logLine({
        dir: 'req',
        seq,
        method: req.method,
        path: url.pathname,
        body,
        serves: turn,
      });

      const anthropic = route === '/messages';
      const responses = route === '/responses';
      if (!body?.stream) {
        return reply(
          200,
          anthropic
            ? anthropicMessage(turn, model, seq)
            : responses
              ? responsesObject(turn, model, seq)
              : openAiCompletion(turn, model, seq)
        );
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      if (anthropic || responses) {
        const events = anthropic
          ? anthropicEvents(turn, model, seq)
          : responsesEvents(turn, model, seq);
        for (const [event, data] of events)
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        logLine({ dir: 'res', seq, status: 200, stream: events });
      } else {
        const chunks = openAiChunks(turn, model, seq);
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.write('data: [DONE]\n\n');
        logLine({ dir: 'res', seq, status: 200, stream: chunks });
      }
      res.end();
    });
  });

  return new Promise(resolve =>
    server.listen(port, host, () => resolve(server))
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({
    options: {
      script: { type: 'string' },
      log: { type: 'string' },
      port: { type: 'string', default: '0' },
      host: { type: 'string', default: '0.0.0.0' },
      upstream: { type: 'string' },
    },
  });
  const server = await startStub({
    script: loadScript(values.script),
    logFile: values.log,
    port: Number(values.port),
    host: values.host,
    upstream: values.upstream,
  });
  process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n');
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
