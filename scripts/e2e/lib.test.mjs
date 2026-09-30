import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeUpstreamReply,
  findLeaks,
  foldEvents,
  interestingLines,
  redactCommandLine,
  redactEnvEntry,
  redactInspect,
  renderSummary,
  stepSlug,
  summarizeModelLog,
  tailLines,
} from './lib.mjs';

test('redactEnvEntry: masks secret-looking names, keeps the rest', () => {
  assert.equal(redactEnvEntry('OPENAI_API_KEY=sk-1'), 'OPENAI_API_KEY=***');
  assert.equal(redactEnvEntry('GITHUB_TOKEN=ghp'), 'GITHUB_TOKEN=***');
  assert.equal(redactEnvEntry('E_ROLE=parent'), 'E_ROLE=parent');
  assert.equal(redactEnvEntry('NOEQUALS'), 'NOEQUALS');
});

test('redactInspect: masks Config.Env and leaves other fields alone', () => {
  const out = redactInspect({
    Name: '/x',
    Config: { Env: ['A=1', 'MY_SECRET=s'], Image: 'img' },
  });
  assert.deepEqual(out.Config.Env, ['A=1', 'MY_SECRET=***']);
  assert.equal(out.Config.Image, 'img');
  assert.equal(out.Name, '/x');
  assert.deepEqual(redactInspect({}), {});
});

test('redactCommandLine: masks -e secrets inside a logged docker argv', () => {
  assert.equal(
    redactCommandLine('> docker run -e E_ROLE=parent -e API_KEY=abc img'),
    '> docker run -e E_ROLE=parent -e API_KEY=*** img'
  );
});

test('stepSlug: names a step after its first words, no flags', () => {
  assert.equal(
    stepSlug(['spawn', '--skill', 'x', 'e2e-pi', 'Write hello.txt now']),
    'spawn-x-e2e-pi'
  );
  assert.equal(stepSlug(['--help']), 'e');
});

const ev = (Type, Action, ID, Attributes, time) => ({
  Type,
  Action,
  Actor: { ID, Attributes },
  timeNano: time * 1e6,
});

test('foldEvents + findLeaks: lifecycles and what was left behind', () => {
  const folded = foldEvents([
    ev('container', 'create', 'c1', { name: 'run', image: 'e-agent-x' }, 1000),
    ev('container', 'start', 'c1', { name: 'run' }, 1100),
    ev('container', 'die', 'c1', { name: 'run', exitCode: '3' }, 2100),
    ev('container', 'destroy', 'c1', { name: 'run' }, 2200),
    ev(
      'container',
      'create',
      'c2',
      { name: 'broker', image: 'e-broker' },
      1000
    ),
    ev('container', 'start', 'c2', { name: 'broker' }, 1000),
    ev('container', 'exec_create: sh', 'c3', { name: 'omniroute' }, 1500),
    ev('network', 'create', 'n1', { name: 'run-net' }, 900),
    ev('network', 'create', 'n2', { name: 'gone-net' }, 900),
    ev('network', 'destroy', 'n2', { name: 'gone-net' }, 3000),
    ev('image', 'tag', 'sha', { name: 'e-agent-x:latest' }, 800),
  ]);
  const run = folded.containers.find(c => c.id === 'c1');
  assert.equal(run.exitCode, 3);
  assert.equal(run.diedAt - run.startedAt, 1000);
  assert.deepEqual(folded.images, ['e-agent-x:latest']);

  const leaks = findLeaks(folded);
  assert.deepEqual(
    leaks.containers.map(c => [c.name, c.running]),
    [['broker', true]]
  );
  assert.deepEqual(leaks.networks, ['run-net']);
  // An engine that already removed the object is no leak.
  assert.deepEqual(findLeaks(folded, () => false).containers, []);
});

test('summarizeModelLog: one line per served request', () => {
  const rows = summarizeModelLog([
    { dir: 'req', path: '/v1/models' },
    {
      dir: 'req',
      seq: 1,
      path: '/v1/chat/completions',
      body: {
        model: 'stub',
        messages: [{}, {}],
        tools: [{ function: { name: 'bash' } }, { name: 'Read' }],
      },
      serves: { tool: 'bash', args: { command: 'ls' } },
    },
    { dir: 'res', seq: 1 },
    { dir: 'req', seq: 2, body: {}, serves: { text: 'done' } },
    { dir: 'req', seq: 3, body: {}, upstream: 'http://u' },
    {
      dir: 'res',
      seq: 3,
      status: 200,
      raw: [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"write","arguments":"{\\"path\\""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"a\\"}"}}]}}]}',
        'data: [DONE]',
      ].join('\n'),
    },
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].tools, ['bash', 'Read']);
  assert.equal(rows[0].served, 'bash({"command":"ls"})');
  assert.equal(rows[1].served, 'text: "done"');
  assert.equal(rows[2].served, 'upstream 200: write({"path":"a"})');
});

test('interestingLines + tailLines: commands, errors, and the output tail', () => {
  const text = [
    '[0.1s] [out] > docker run -e API_KEY=x img',
    '[0.2s] [err] Unknown skill "p". Error: bad',
    '[0.3s] [err] warning: could not open PR',
    '[0.4s] [err] #5 2.7 npm warn deprecated',
    '[0.5s] [out] ',
    '[0.6s] [out] Run branch: e/x/y-1',
    '[0.7s] [tty] > docker run -it --rm img',
  ].join('\n');
  const lines = interestingLines(text);
  assert.deepEqual(lines.commands, [
    '> docker run -e API_KEY=*** img',
    '> docker run -it --rm img',
  ]);
  assert.equal(lines.errors.length, 1);
  assert.equal(lines.warnings.length, 2);
  assert.deepEqual(tailLines(text, 2), [
    '[0.6s] [out] Run branch: e/x/y-1',
    '[0.7s] [tty] > docker run -it --rm img',
  ]);
});

test('renderSummary: exit, containers of the step only, model, git, leaks', () => {
  const md = renderSummary({
    step: 1,
    argv: ['spawn', 'e2e-pi', 'hi'],
    cwd: '/r',
    exit: { code: 0 },
    durationMs: 1500,
    model: 'stub',
    lines: { commands: ['> docker run x'], errors: [], warnings: [] },
    tail: ['[1s] [out] done'],
    folded: {
      containers: [
        {
          name: 'run',
          image: 'i',
          createdAt: 1,
          startedAt: 1,
          diedAt: 2,
          exitCode: 0,
          destroyedAt: 3,
        },
        { name: 'omniroute', image: 'o', actions: ['exec_create'] },
      ],
      networks: [],
      volumes: [],
      images: [],
    },
    modelSummary: [],
    git: { graph: '* seed', remote: '', newBranches: [] },
    leaks: {
      containers: [],
      networks: ['n'],
      volumes: [],
      worktrees: [],
      scratch: ['/tmp/e-scratch-x'],
    },
  });
  assert.match(md, /exit: \*\*0\*\*/);
  assert.match(md, /\| run \| i \| 0 \|/);
  assert.doesNotMatch(md, /omniroute/);
  assert.match(md, /never reached the model/);
  assert.match(md, /- network n/);
  assert.match(md, /- scratch dir \/tmp\/e-scratch-x \(rendered secrets/);
  assert.match(md, /\[1s\] \[out\] done/);
});

test('describeUpstreamReply: plain JSON text, and nothing captured', () => {
  assert.equal(
    describeUpstreamReply(
      JSON.stringify({ choices: [{ message: { content: 'hello' } }] })
    ),
    'text: "hello"'
  );
  assert.equal(describeUpstreamReply(undefined), '(no reply captured)');
  const responses = [
    'event: response.output_item.done',
    'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"f1","name":"shell","arguments":"{}"}}',
  ].join('\n');
  assert.equal(describeUpstreamReply(responses), 'shell({})');
  const anthropic = [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"Bash"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi"}}',
  ].join('\n');
  assert.equal(describeUpstreamReply(anthropic), 'Bash({}), text: "hi"');
});
