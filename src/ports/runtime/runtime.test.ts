import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  ContainerRuntime,
  type RunOptions,
  type SidecarSpec,
} from './index.js';
import {
  composeUpArgs,
  composeWaitArgs,
  composeRestartArgs,
} from './compose.js';

// buildRunArgs is pure argv construction - no child process is spawned - so we
// exercise it directly on a concrete ContainerRuntime and assert the exact
// argument list. `command` is irrelevant here (it's the executable, not an
// arg), so any value does.
const runtime = new ContainerRuntime('docker');

/**
 * A {@link ContainerRuntime} whose synchronous engine calls are recorded
 * instead of run. The argv builders are private now, so this is how a test
 * sees the argv - through the method that uses it, which is the only place a
 * wrong builder and a wrong call site both show up.
 */
function recording(stdout = ''): {
  runtime: ContainerRuntime;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec = ((_engine: string, args: readonly string[]) => {
    calls.push([...args]);
    return { status: 0, stdout, stderr: '', signal: null, output: [], pid: 0 };
  }) as unknown as typeof spawnSync;
  return {
    runtime: new ContainerRuntime('docker', undefined, exec),
    calls,
  };
}

function argsFor(
  opts: RunOptions,
  commandArgs: string[] = [],
  image = 'img'
): string[] {
  return runtime.buildRunArgs(image, opts, commandArgs);
}

const cases: Array<{ name: string; opts: RunOptions; expected: string[] }> = [
  {
    name: 'plain: run in the foreground with no extra flags',
    opts: {},
    expected: ['run', 'img'],
  },
  {
    name: 'interactive: keeps stdin open and allocates a TTY',
    opts: { interactive: true },
    expected: ['run', '-it', 'img'],
  },
  {
    name: 'interactive + headlessTty: detaches so the CLI does not demand a host TTY',
    opts: { interactive: true, headlessTty: true },
    expected: ['run', '-d', '-it', 'img'],
  },
  {
    name: 'headlessTty without interactive: no effect',
    opts: { headlessTty: true },
    expected: ['run', 'img'],
  },
  {
    name: '--rm / --name / -w in order',
    opts: { rm: true, name: 'run-1', workdir: '/workspace' },
    expected: ['run', '--rm', '--name', 'run-1', '-w', '/workspace', 'img'],
  },
  {
    name: '--network follows -w, before env-files',
    opts: {
      name: 'run-1',
      workdir: '/workspace',
      networks: ['run-1-net'],
    },
    expected: [
      'run',
      '--name',
      'run-1',
      '-w',
      '/workspace',
      '--network',
      'run-1-net',
      'img',
    ],
  },
  {
    name: 'multi --network keeps order',
    opts: {
      networks: ['run-1-net', 'other-net'],
    },
    expected: [
      'run',
      '--network',
      'run-1-net',
      '--network',
      'other-net',
      'img',
    ],
  },
  {
    name: 'netns: --network container:<name> replaces networks',
    opts: {
      netns: 'e-demo-fix-1-egress',
      networks: ['run-1-net'],
    },
    expected: ['run', '--network', 'container:e-demo-fix-1-egress', 'img'],
  },
  {
    name: '--env-file entries keep their order',
    opts: { envFile: ['/base.env', '/user.env'] },
    expected: [
      'run',
      '--env-file',
      '/base.env',
      '--env-file',
      '/user.env',
      'img',
    ],
  },
  {
    name: 'volumes, ports, env vars follow env-files, each repeated in order',
    opts: {
      volumes: [
        { host: '/wt', container: '/workspace' },
        { host: '/cache', container: '/cache' },
      ],
      port: ['8080:80', '9090:90'],
      env: ['A=1', 'B=2'],
    },
    expected: [
      'run',
      '-v',
      '/wt:/workspace',
      '-v',
      '/cache:/cache',
      '-p',
      '8080:80',
      '-p',
      '9090:90',
      '-e',
      'A=1',
      '-e',
      'B=2',
      'img',
    ],
  },
];

for (const { name, opts, expected } of cases) {
  test(`buildRunArgs: ${name}`, () => {
    assert.deepEqual(argsFor(opts), expected);
  });
}

test('buildRunArgs: full ordering - flags, env-files, v/p/e, image, then command args', () => {
  const args = argsFor(
    {
      rm: true,
      name: 'run-1',
      workdir: '/workspace',
      envFile: ['/base.env', '/user.env'],
      volumes: [{ host: '/wt', container: '/workspace' }],
      port: ['8080:80'],
      env: ['K=v'],
    },
    ['claude', '-p', 'hi']
  );
  assert.deepEqual(args, [
    'run',
    '--rm',
    '--name',
    'run-1',
    '-w',
    '/workspace',
    '--env-file',
    '/base.env',
    '--env-file',
    '/user.env',
    '-v',
    '/wt:/workspace',
    '-p',
    '8080:80',
    '-e',
    'K=v',
    'img',
    'claude',
    '-p',
    'hi',
  ]);
});

test('buildRunArgs: command args trail the image', () => {
  assert.deepEqual(argsFor({}, ['sh', '-c', 'echo hi']), [
    'run',
    'img',
    'sh',
    '-c',
    'echo hi',
  ]);
});

test('buildRunArgs: renders explicit host mappings', () => {
  assert.deepEqual(argsFor({ extraHosts: ['example.test:192.0.2.1'] }), [
    'run',
    '--add-host',
    'example.test:192.0.2.1',
    'img',
  ]);
});

test('composeUpArgs: starts the selected Compose file detached', () => {
  assert.deepEqual(composeUpArgs('/project/.e/compose.yaml'), [
    'compose',
    '-f',
    '/project/.e/compose.yaml',
    'up',
    '-d',
    '--build',
  ]);
});

test('composeUpArgs: passes the store env-file for secret interpolation', () => {
  assert.deepEqual(
    composeUpArgs('/project/.e/compose.yaml', '/project/.e/.env'),
    [
      'compose',
      '--env-file',
      '/project/.e/.env',
      '-f',
      '/project/.e/compose.yaml',
      'up',
      '-d',
      '--build',
    ]
  );
});

test('composeWaitArgs: waits for generated bootstrap service', () => {
  assert.deepEqual(composeWaitArgs('/project/.e/compose.yaml'), [
    'compose',
    '-f',
    '/project/.e/compose.yaml',
    'wait',
    'bootstrap',
  ]);
});

test('composeWaitArgs: passes the store env-file for secret interpolation', () => {
  assert.deepEqual(
    composeWaitArgs('/project/.e/compose.yaml', '/project/.e/.env'),
    [
      'compose',
      '--env-file',
      '/project/.e/.env',
      '-f',
      '/project/.e/compose.yaml',
      'wait',
      'bootstrap',
    ]
  );
});

test('composeRestartArgs: restarts the llama service by default', () => {
  assert.deepEqual(composeRestartArgs('/project/.e/compose.yaml'), [
    'compose',
    '-f',
    '/project/.e/compose.yaml',
    'restart',
    'llama',
  ]);
});

test('composeRestartArgs: passes the store env-file for secret interpolation', () => {
  assert.deepEqual(
    composeRestartArgs('/project/.e/compose.yaml', '/project/.e/.env'),
    [
      'compose',
      '--env-file',
      '/project/.e/.env',
      '-f',
      '/project/.e/compose.yaml',
      'restart',
      'llama',
    ]
  );
});

test('composeUp: no-runtime path uses ordinary compose-up argv', () => {
  // `composeUp(..., false)` uses this argv and intentionally omits the
  // bootstrap wait. Process invocation is integration-owned.
  assert.deepEqual(composeUpArgs('/project/.e/compose.yaml'), [
    'compose',
    '-f',
    '/project/.e/compose.yaml',
    'up',
    '-d',
    '--build',
  ]);
});

// --- structured mounts ---

test('a read-write mount renders host:container', () => {
  assert.deepEqual(
    argsFor({ volumes: [{ host: '/wt', container: '/workspace' }] }),
    ['run', '-v', '/wt:/workspace', 'img']
  );
});

test('a read-only mount appends :ro', () => {
  assert.deepEqual(
    argsFor({
      volumes: [
        { host: '/s', container: '/home/node/.claude/skills/x', ro: true },
      ],
    }),
    ['run', '-v', '/s:/home/node/.claude/skills/x:ro', 'img']
  );
});

test('buildRunArgs: a read-only mount renders host:container:ro', () => {
  assert.deepEqual(
    argsFor({
      volumes: [{ host: '/s', container: '/skills/x', ro: true }],
    }),
    ['run', '-v', '/s:/skills/x:ro', 'img']
  );
});

// --- pure subcommand arg builders (previously trapped inside spawnSync) ---

test('isAvailable asks the engine for its version', () => {
  const { runtime, calls } = recording();
  runtime.isAvailable();
  assert.deepEqual(calls[0], ['--version']);
});

test('imageExists inspects the image', () => {
  const { runtime, calls } = recording();
  runtime.imageExists('e-harness-codex');
  assert.deepEqual(calls[0], ['image', 'inspect', 'e-harness-codex']);
});

test('build: tag then context, default Dockerfile', () => {
  const { runtime, calls } = recording();
  runtime.build('e-agent-x', '/ctx');
  assert.deepEqual(calls[0], ['build', '-t', 'e-agent-x', '/ctx']);
});

test('build: explicit -f Dockerfile precedes the context', () => {
  const { runtime, calls } = recording();
  runtime.build('e-agent-x', '/ctx', '/ctx/Other');
  assert.deepEqual(calls[0], [
    'build',
    '-t',
    'e-agent-x',
    '-f',
    '/ctx/Other',
    '/ctx',
  ]);
});

test('createNetwork and removeNetwork name the network once each', () => {
  const { runtime, calls } = recording();
  runtime.createNetwork('run-1-net');
  runtime.removeNetwork('run-1-net');
  assert.deepEqual(calls, [
    ['network', 'create', 'run-1-net'],
    ['network', 'rm', 'run-1-net'],
  ]);
});

test('removeContainer force-removes by name', () => {
  const { runtime, calls } = recording();
  runtime.removeContainer('run-1-mcp-everything');
  assert.deepEqual(calls[0], ['rm', '-f', 'run-1-mcp-everything']);
});

test('startSidecar: detached, named, on its network with an alias', () => {
  const { runtime, calls } = recording();
  const spec: SidecarSpec = {
    name: 'run-1-mcp-everything',
    alias: 'everything',
    image: 'e-mcp-everything',
    network: 'run-1-net',
    port: 3001,
  };
  runtime.startSidecar(spec);
  assert.deepEqual(calls[0], [
    'run',
    '-d',
    '--name',
    'run-1-mcp-everything',
    '--network',
    'run-1-net',
    '--network-alias',
    'everything',
    'e-mcp-everything',
  ]);
});

test('startSidecar: env-files precede the image, in order', () => {
  const { runtime, calls } = recording();
  const spec: SidecarSpec = {
    name: 'run-1-mcp-x',
    alias: 'x',
    image: 'e-mcp-x',
    network: 'run-1-net',
    port: 8000,
    envFile: ['/a.env', '/b.env'],
  };
  runtime.startSidecar(spec);
  assert.deepEqual(calls[0], [
    'run',
    '-d',
    '--name',
    'run-1-mcp-x',
    '--network',
    'run-1-net',
    '--network-alias',
    'x',
    '--env-file',
    '/a.env',
    '--env-file',
    '/b.env',
    'e-mcp-x',
  ]);
});

test('probeTcp: throwaway busybox nc on the private network', () => {
  const { runtime, calls } = recording();
  runtime.probeTcp('run-1-net', 'everything', 3001);
  assert.deepEqual(calls[0], [
    'run',
    '--rm',
    '--network',
    'run-1-net',
    'busybox',
    'nc',
    '-w',
    '2',
    'everything',
    '3001',
  ]);
});

test('volume operations surface a failing or missing runtime instead of returning silently', () => {
  // `false` exits 1 for every subcommand; a nonexistent binary cannot start.
  const failing = new ContainerRuntime('false');
  assert.throws(() => failing.createVolume('v'), /failed to create volume v/);
  assert.throws(
    () => failing.copyVolumeToDir('v', '/tmp/out'),
    /failed to copy volume v to \/tmp\/out/
  );
  assert.throws(
    () => failing.copyDirToVolume('/tmp/in', 'v', true),
    /failed to copy \/tmp\/in into volume v/
  );
  const missing = new ContainerRuntime('e-no-such-runtime-binary');
  assert.throws(() => missing.createVolume('v'), /Failed to start/);
});

test('probeHealthcheck: the command trails exec <container>', () => {
  const { runtime, calls } = recording();
  runtime.probeHealthcheck('run-1-mcp-x', ['sh', '-c', 'true']);
  assert.deepEqual(calls[0], ['exec', 'run-1-mcp-x', 'sh', '-c', 'true']);
});

test('isRunning inspects the Running state', () => {
  const { runtime, calls } = recording();
  runtime.isRunning('run-1-mcp-x');
  assert.deepEqual(calls[0], [
    'inspect',
    '-f',
    '{{.State.Running}}',
    'run-1-mcp-x',
  ]);
});

test('volumeExists inspects the volume', () => {
  const { runtime, calls } = recording();
  runtime.volumeExists('omniroute-data');
  assert.deepEqual(calls[0], ['volume', 'inspect', 'omniroute-data']);
});

test('createVolume creates the volume', () => {
  const { runtime, calls } = recording();
  runtime.createVolume('omniroute-data');
  assert.deepEqual(calls[0], ['volume', 'create', 'omniroute-data']);
});

test('copyVolumeToDir: volume -> host dir via alpine cp', () => {
  const { runtime, calls } = recording();
  runtime.copyVolumeToDir('omniroute-data', '/tmp/out');
  assert.deepEqual(calls[0], [
    'run',
    '--rm',
    '-v',
    'omniroute-data:/source',
    '-v',
    '/tmp/out:/dest',
    'alpine',
    'sh',
    '-c',
    'cp -a /source/. /dest/',
  ]);
});

test('copyDirToVolume: host dir -> volume without a wipe guard', () => {
  const { runtime, calls } = recording();
  runtime.copyDirToVolume('/tmp/in', 'omniroute-data');
  assert.deepEqual(calls[0], [
    'run',
    '--rm',
    '-v',
    '/tmp/in:/source',
    '-v',
    'omniroute-data:/dest',
    'alpine',
    'sh',
    '-c',
    'cp -a /source/. /dest/',
  ]);
});

test('copyDirToVolume: wipe=true prepends the destructive rm guard', () => {
  const { runtime, calls } = recording();
  runtime.copyDirToVolume('/tmp/in', 'omniroute-data', true);
  assert.deepEqual(calls[0], [
    'run',
    '--rm',
    '-v',
    '/tmp/in:/source',
    '-v',
    'omniroute-data:/dest',
    'alpine',
    'sh',
    '-c',
    'rm -rf /dest/* /dest/..?* /dest/.[!.]* 2>/dev/null || true && cp -a /source/. /dest/',
  ]);
});

// --- run(): foreground vs headless-TTY ---------------------------------------
//
// A fake spawner records every argv and scripts each child's stdout/exit, so
// the two run modes are exercised without a container engine.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn as spawnType } from 'node:child_process';

interface ScriptedChild {
  stdout?: string;
  stderr?: string;
  code?: number;
  signal?: string;
}

function fakeSpawner(scripts: ScriptedChild[]): {
  spawn: typeof spawnType;
  calls: Array<{ args: string[]; stdio: unknown }>;
} {
  const calls: Array<{ args: string[]; stdio: unknown }> = [];
  const spawn = ((_command: string, args: string[], options: unknown) => {
    const script = scripts[calls.length] ?? {};
    calls.push({ args, stdio: (options as { stdio: unknown }).stdio });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      if (script.stdout !== undefined) child.stdout.write(script.stdout);
      if (script.stderr !== undefined) child.stderr.write(script.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', script.code ?? 0, script.signal ?? null);
    });
    return child;
  }) as unknown as typeof spawnType;
  return { spawn, calls };
}

test('run: foreground mode inherits stdio and resolves the exit code', async () => {
  const { spawn, calls } = fakeSpawner([{ code: 3 }]);
  const rt = new ContainerRuntime('docker', spawn);
  const code = await rt.run('img', { interactive: true }, ['pi']);
  assert.equal(code, 3);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['run', '-it', 'img', 'pi']);
  assert.equal(calls[0].stdio, 'inherit');
});

test('run: headless TTY detaches, then waits on the printed container id', async () => {
  const { spawn, calls } = fakeSpawner([
    { stdout: 'deadbeefcafe\n' },
    { stdout: '7\n' },
  ]);
  const rt = new ContainerRuntime('docker', spawn);
  const code = await rt.run(
    'img',
    { interactive: true, headlessTty: true, name: 'e-a-b-1' },
    ['pi']
  );
  assert.equal(code, 7);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, [
    'run',
    '-d',
    '-it',
    '--name',
    'e-a-b-1',
    'img',
    'pi',
  ]);
  assert.deepEqual(calls[0].stdio, ['ignore', 'pipe', 'inherit']);
  assert.deepEqual(calls[1].args, ['wait', 'deadbeefcafe']);
});

test('run: headless TTY reports a failed start without waiting', async () => {
  const { spawn, calls } = fakeSpawner([{ stdout: '', code: 125 }]);
  const rt = new ContainerRuntime('docker', spawn);
  const code = await rt.run(
    'img',
    { interactive: true, headlessTty: true },
    []
  );
  assert.equal(code, 125);
  assert.equal(calls.length, 1);
});

test('run: headless TTY treats an unparsable wait result as failure', async () => {
  const { spawn } = fakeSpawner([{ stdout: 'abc\n' }, { stdout: 'nope\n' }]);
  const rt = new ContainerRuntime('docker', spawn);
  const code = await rt.run(
    'img',
    { interactive: true, headlessTty: true },
    []
  );
  assert.equal(code, 1);
});

test('startSidecar: bind mounts follow the env-files and precede the image', () => {
  const { runtime, calls } = recording();
  const spec: SidecarSpec = {
    name: 'run-1-broker',
    alias: 'runtime-broker',
    image: 'e-broker',
    network: 'run-1-net',
    port: 20130,
    volumes: [{ host: '/tmp/spool', container: '/var/lib/e-broker' }],
  };
  runtime.startSidecar(spec);
  assert.deepEqual(calls[0], [
    'run',
    '-d',
    '--name',
    'run-1-broker',
    '--network',
    'run-1-net',
    '--network-alias',
    'runtime-broker',
    '-v',
    '/tmp/spool:/var/lib/e-broker',
    'e-broker',
  ]);
});

// --- what the class does with a failing engine ---------------------------
//
// These were unreachable while the argv builders were the test surface: a
// builder cannot fail, only the call that uses it can.

/** A recorder whose engine answers with `status`, or fails to start at all. */
function failing(result: { status?: number; error?: Error }): ContainerRuntime {
  const exec = ((): unknown => ({
    status: result.status ?? 1,
    stdout: '',
    stderr: '',
    signal: null,
    output: [],
    pid: 0,
    ...(result.error ? { error: result.error } : {}),
  })) as unknown as typeof spawnSync;
  return new ContainerRuntime('docker', undefined, exec);
}

test('build throws when the engine exits non-zero, so a broken image ends the spawn', () => {
  assert.throws(
    () => failing({ status: 1 }).build('e-agent-x', '/ctx'),
    /Build failed|failed/i
  );
});

test('build throws when the engine cannot start at all', () => {
  assert.throws(
    () => failing({ error: new Error('ENOENT') }).build('e-agent-x', '/ctx'),
    /Failed to start docker/
  );
});

test('createNetwork throws, because a run without its network cannot proceed', () => {
  assert.throws(() => failing({ status: 1 }).createNetwork('run-1-net'));
});

test('removeNetwork never throws: it runs in teardown, where a failure must not mask the result', () => {
  assert.doesNotThrow(() => failing({ status: 1 }).removeNetwork('run-1-net'));
});

test('removeContainer never throws either, for the same reason', () => {
  assert.doesNotThrow(() => failing({ status: 1 }).removeContainer('c'));
});

test('a failing probe is a negative answer, not an error', () => {
  const runtime = failing({ status: 1 });
  assert.equal(runtime.probeTcp('net', 'host', 80), false);
  assert.equal(runtime.isRunning('c'), false);
  assert.equal(runtime.imageExists('img'), false);
  assert.equal(runtime.volumeExists('v'), false);
  assert.equal(runtime.isAvailable(), false);
});

// --- runCaptured(): the gate's output has to come back, not just scroll past --

test('runCaptured: resolves the exit code with the combined output, in arrival order', async () => {
  const { spawn, calls } = fakeSpawner([
    { stdout: 'running tests\n', stderr: 'FAIL auth\n', code: 1 },
  ]);
  const rt = new ContainerRuntime('docker', spawn);
  const result = await rt.runCaptured('img', { rm: true }, [
    'sh',
    '-c',
    'npm test',
  ]);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /running tests/);
  assert.match(result.output, /FAIL auth/);
  assert.deepEqual(calls[0].args, [
    'run',
    '--rm',
    'img',
    'sh',
    '-c',
    'npm test',
  ]);
  assert.deepEqual(
    calls[0].stdio,
    ['ignore', 'pipe', 'pipe'],
    'both streams are read, so neither is lost to the terminal'
  );
});

test('runCaptured: the human still sees the check while it runs', async () => {
  const { spawn } = fakeSpawner([{ stdout: 'tick\n', stderr: 'tock\n' }]);
  const rt = new ContainerRuntime('docker', spawn);
  const seen: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => (seen.push(String(c)), true)) as never;
  process.stderr.write = ((c: string) => (seen.push(String(c)), true)) as never;
  try {
    await rt.runCaptured('img', {}, ['sh', '-c', 'true']);
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  assert.ok(seen.join('').includes('tick'), 'stdout is passed through');
  assert.ok(seen.join('').includes('tock'), 'stderr is passed through');
});

// --- resource caps (ADR-0016) ------------------------------------------------

test('buildRunArgs: memory pins --memory-swap to the same value', () => {
  // Without the pin Docker allows as much again in swap, so `memory` would not
  // mean what it says.
  assert.deepEqual(argsFor({ memory: '4g' }), [
    'run',
    '--memory',
    '4g',
    '--memory-swap',
    '4g',
    'img',
  ]);
});

test('buildRunArgs: cpus and pidsLimit reach the engine', () => {
  assert.deepEqual(argsFor({ cpus: 2, pidsLimit: 2048 }), [
    'run',
    '--cpus',
    '2',
    '--pids-limit',
    '2048',
    'img',
  ]);
});

test('buildRunArgs: an unset cap emits no flag at all', () => {
  assert.deepEqual(argsFor({}), ['run', 'img']);
});

test('startSidecar: e own infrastructure is never capped', () => {
  const { runtime: rt, calls } = recording();
  rt.startSidecar({
    name: 'run-mcp-x',
    image: 'img',
    alias: 'x',
    network: 'net',
    port: 3000,
  });
  const args = calls[0].join(' ');
  assert.ok(!args.includes('--memory'), 'a limit here breaks e, not the run');
  assert.ok(!args.includes('--pids-limit'));
});
