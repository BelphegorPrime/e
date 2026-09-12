import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TerminalRequestError,
  TerminalSessions,
  type TerminalControlMessage,
} from './terminalSessions.js';
import { fakeEngine, scriptedSpawner } from './terminalSessions.testSupport.js';

function recorder(): {
  client: {
    write(data: Buffer): void;
    control(m: TerminalControlMessage): void;
  };
  output: () => string;
  controls: TerminalControlMessage[];
} {
  const chunks: Buffer[] = [];
  const controls: TerminalControlMessage[] = [];
  return {
    client: {
      write: data => chunks.push(data),
      control: message => controls.push(message),
    },
    output: () => Buffer.concat(chunks).toString(),
    controls,
  };
}

const tick = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));

test('start refuses without an engine, with a bad agent or a bad run name', () => {
  const spawner = scriptedSpawner();
  const noEngine = new TerminalSessions({
    engine: undefined,
    spawnChild: spawner.spawn,
  });
  assert.throws(() => noEngine.start({ agent: 'pi' }), TerminalRequestError);
  assert.equal(noEngine.engineAvailable, false);

  const sessions = new TerminalSessions({
    engine: fakeEngine({}),
    spawnChild: spawner.spawn,
  });
  assert.throws(() => sessions.start({ agent: 'a b' }), TerminalRequestError);
  assert.throws(
    () => sessions.start({ agent: 'pi', name: 'Has Spaces' }),
    TerminalRequestError
  );
  assert.equal(spawner.calls.length, 0);
  sessions.dispose();
});

test('start spawns a headless `e spawn` with a generated run name', () => {
  const spawner = scriptedSpawner();
  const sessions = new TerminalSessions({
    engine: fakeEngine({}),
    spawnChild: spawner.spawn,
    now: () => new Date(1_700_000_000_000),
  });
  const info = sessions.start({ agent: 'smart-pi' });
  assert.equal(info.agent, 'smart-pi');
  assert.match(info.slug, /^ui-[0-9a-z]+$/);
  assert.equal(info.phase, 'starting');
  assert.equal(info.createdAt, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(spawner.calls, [['spawn', 'smart-pi', '--name', info.slug]]);
  assert.deepEqual(sessions.list(), [info]);
  assert.equal(sessions.get(info.id), info);
  sessions.dispose();
});

test('start passes selected skills and MCP servers as spawn flags', () => {
  const spawner = scriptedSpawner();
  const sessions = new TerminalSessions({
    engine: fakeEngine({}),
    spawnChild: spawner.spawn,
    listSkills: () => ['caveman', 'web-search'],
    listMcpServers: () => [
      { name: 'everything', transport: 'container' },
      { name: 'hosted', transport: 'remote' },
    ],
  });
  sessions.start({
    agent: 'pi',
    name: 'demo',
    skills: ['caveman', 'web-search'],
    mcp: ['everything', 'hosted'],
  });
  assert.deepEqual(spawner.calls, [
    [
      'spawn',
      'pi',
      '--name',
      'demo',
      '--skill',
      'caveman',
      '--skill',
      'web-search',
      '--mcp',
      'everything',
      '--mcp',
      'hosted',
    ],
  ]);
  sessions.dispose();
});

test('start refuses skills or MCP servers the store does not know', () => {
  const spawner = scriptedSpawner();
  const sessions = new TerminalSessions({
    engine: fakeEngine({}),
    spawnChild: spawner.spawn,
    listSkills: () => ['caveman'],
    listMcpServers: () => [{ name: 'everything', transport: 'container' }],
  });
  assert.throws(
    () => sessions.start({ agent: 'pi', skills: ['ghost'] }),
    /Unknown skill "ghost"/
  );
  assert.throws(
    () => sessions.start({ agent: 'pi', mcp: ['ghost'] }),
    /Unknown MCP server "ghost"/
  );
  assert.throws(
    () => sessions.start({ agent: 'pi', skills: ['../evil'] }),
    /Invalid skill name/
  );
  assert.equal(spawner.calls.length, 0);
  sessions.dispose();
});

test('options lists the store skills and MCP servers with their transport', () => {
  const sessions = new TerminalSessions({
    engine: fakeEngine({}),
    listSkills: () => ['caveman'],
    listMcpServers: () => [
      { name: 'everything', transport: 'container' },
      { name: 'hosted', transport: 'remote' },
    ],
  });
  assert.deepEqual(sessions.options(), {
    skills: ['caveman'],
    mcp: [
      { name: 'everything', transport: 'container' },
      { name: 'hosted', transport: 'remote' },
    ],
  });
  sessions.dispose();
});

test('child output streams to clients with CRLF and replays to late joiners', async t => {
  const spawner = scriptedSpawner();
  const sessions = new TerminalSessions({
    engine: fakeEngine({}),
    spawnChild: spawner.spawn,
    pollIntervalMs: 1000,
  });
  t.after(() => sessions.dispose());
  const info = sessions.start({ agent: 'pi', name: 'demo' });
  const early = recorder();
  sessions.attachClient(info.id, early.client);
  spawner.children[0].stdout.write('Building image\n');
  spawner.children[0].stderr.write('warn: slow\n');
  await tick(1);
  assert.equal(early.output(), 'Building image\r\nwarn: slow\r\n');
  assert.deepEqual(early.controls, [{ type: 'status', session: info }]);

  const late = recorder();
  sessions.attachClient(info.id, late.client);
  assert.equal(late.output(), 'Building image\r\nwarn: slow\r\n');
});

test('a session attaches once the run container appears, then relays bytes both ways', async t => {
  const spawner = scriptedSpawner();
  const engine = fakeEngine({});
  const sessions = new TerminalSessions({
    engine,
    spawnChild: spawner.spawn,
    pollIntervalMs: 5,
  });
  t.after(() => sessions.dispose());
  const info = sessions.start({ agent: 'pi', name: 'demo' });
  const browser = recorder();
  sessions.attachClient(info.id, browser.client);
  // Typed before attach: dropped, not queued into the wrong place.
  sessions.input(info.id, Buffer.from('early'));
  sessions.resize(info.id, 120, 40);

  // A sibling slug must not match; the exact run container must.
  engine.state.containers.push({ id: 'x', name: 'e-pi-demo-extra-1' });
  await tick();
  assert.equal(info.phase, 'starting');
  engine.state.containers.push({ id: 'c1', name: 'e-pi-demo-3' });
  await tick();
  assert.equal(info.phase, 'attached');
  assert.equal(info.containerName, 'e-pi-demo-3');
  assert.deepEqual(engine.state.resizes, [
    { container: 'e-pi-demo-3', cols: 120, rows: 40 },
  ]);
  assert.deepEqual(browser.controls.at(-1), { type: 'status', session: info });

  engine.state.attached?.toBrowser.write(Buffer.from('\x1b[2J> '));
  await tick(1);
  assert.ok(browser.output().endsWith('\x1b[2J> '));

  const typed: Buffer[] = [];
  engine.state.attached?.fromBrowser.on('data', chunk => typed.push(chunk));
  sessions.input(info.id, Buffer.from('ls\r'));
  await tick(1);
  assert.equal(Buffer.concat(typed).toString(), 'ls\r');

  sessions.resize(info.id, 0, 10);
  sessions.resize(info.id, 80, 24);
  assert.deepEqual(engine.state.resizes.at(-1), {
    container: 'e-pi-demo-3',
    cols: 80,
    rows: 24,
  });

  spawner.children[0].stdout.write('Pushed to origin.\n');
  spawner.children[0].exit(0);
  await tick(1);
  assert.equal(info.phase, 'exited');
  assert.equal(info.exitCode, 0);
  assert.ok(browser.output().endsWith('Pushed to origin.\r\n'));
  assert.deepEqual(browser.controls.at(-1), { type: 'status', session: info });

  sessions.remove(info.id);
  assert.deepEqual(sessions.list(), []);
});

test('an attach failure is reported once and the session keeps waiting', async t => {
  const spawner = scriptedSpawner();
  const engine = fakeEngine({
    containers: [{ id: 'c1', name: 'e-pi-demo-1' }],
    attachError: new Error('engine says no'),
  });
  const sessions = new TerminalSessions({
    engine,
    spawnChild: spawner.spawn,
    pollIntervalMs: 5,
  });
  t.after(() => sessions.dispose());
  const info = sessions.start({ agent: 'pi', name: 'demo' });
  const browser = recorder();
  sessions.attachClient(info.id, browser.client);
  await tick(30);
  assert.equal(info.phase, 'starting');
  const errors = browser.controls.filter(message => message.type === 'error');
  assert.deepEqual(errors, [{ type: 'error', message: 'engine says no' }]);

  // A failed child start ends the session with exit code 1.
  spawner.children[0].fail(new Error('ENOENT'));
  assert.equal(info.phase, 'exited');
  assert.equal(info.exitCode, 1);
  assert.match(browser.output(), /e spawn could not start: ENOENT/);
});

test('remove refuses a running session and the replay buffer is capped', async t => {
  const spawner = scriptedSpawner();
  const sessions = new TerminalSessions({
    engine: fakeEngine({}),
    spawnChild: spawner.spawn,
    pollIntervalMs: 1000,
    bufferLimit: 10,
  });
  t.after(() => sessions.dispose());
  const info = sessions.start({ agent: 'pi', name: 'demo' });
  assert.throws(() => sessions.remove(info.id), TerminalRequestError);
  spawner.children[0].stdout.write('12345');
  spawner.children[0].stdout.write('67890');
  spawner.children[0].stdout.write('abcde');
  await tick(1);
  const late = recorder();
  sessions.attachClient(info.id, late.client);
  assert.equal(late.output(), '67890abcde');
});
