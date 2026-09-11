import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ContainerRuntime,
  formatMount,
  versionArgs,
  imageInspectArgs,
  buildImageArgs,
  networkCreateArgs,
  networkRemoveArgs,
  sidecarRunArgs,
  containerRemoveArgs,
  tcpProbeArgs,
  execArgs,
  runningInspectArgs,
  volumeInspectArgs,
  volumeCreateArgs,
  volumeCopyOutArgs,
  volumeCopyInArgs,
  waitArgs,
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

test('formatMount: read-write omits :ro', () => {
  assert.equal(
    formatMount({ host: '/wt', container: '/workspace' }),
    '/wt:/workspace'
  );
});

test('formatMount: ro appends :ro', () => {
  assert.equal(
    formatMount({
      host: '/s',
      container: '/home/node/.claude/skills/x',
      ro: true,
    }),
    '/s:/home/node/.claude/skills/x:ro'
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

test('versionArgs', () => {
  assert.deepEqual(versionArgs(), ['--version']);
});

test('imageInspectArgs', () => {
  assert.deepEqual(imageInspectArgs('e-harness-codex'), [
    'image',
    'inspect',
    'e-harness-codex',
  ]);
});

test('buildImageArgs: tag then context, default Dockerfile', () => {
  assert.deepEqual(buildImageArgs('e-agent-x', '/ctx'), [
    'build',
    '-t',
    'e-agent-x',
    '/ctx',
  ]);
});

test('buildImageArgs: explicit -f Dockerfile precedes the context', () => {
  assert.deepEqual(buildImageArgs('e-agent-x', '/ctx', '/ctx/Other'), [
    'build',
    '-t',
    'e-agent-x',
    '-f',
    '/ctx/Other',
    '/ctx',
  ]);
});

test('networkCreateArgs / networkRemoveArgs', () => {
  assert.deepEqual(networkCreateArgs('run-1-net'), [
    'network',
    'create',
    'run-1-net',
  ]);
  assert.deepEqual(networkRemoveArgs('run-1-net'), [
    'network',
    'rm',
    'run-1-net',
  ]);
});

test('containerRemoveArgs force-removes by name', () => {
  assert.deepEqual(containerRemoveArgs('run-1-mcp-everything'), [
    'rm',
    '-f',
    'run-1-mcp-everything',
  ]);
});

test('sidecarRunArgs: detached, named, on its network with an alias', () => {
  const spec: SidecarSpec = {
    name: 'run-1-mcp-everything',
    alias: 'everything',
    image: 'e-mcp-everything',
    network: 'run-1-net',
    port: 3001,
  };
  assert.deepEqual(sidecarRunArgs(spec), [
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

test('sidecarRunArgs: env-files precede the image, in order', () => {
  const spec: SidecarSpec = {
    name: 'run-1-mcp-x',
    alias: 'x',
    image: 'e-mcp-x',
    network: 'run-1-net',
    port: 8000,
    envFile: ['/a.env', '/b.env'],
  };
  assert.deepEqual(sidecarRunArgs(spec), [
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

test('tcpProbeArgs: throwaway busybox nc on the private network', () => {
  assert.deepEqual(tcpProbeArgs('run-1-net', 'everything', 3001), [
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

test('execArgs: the command trails exec <container>', () => {
  assert.deepEqual(execArgs('run-1-mcp-x', ['sh', '-c', 'true']), [
    'exec',
    'run-1-mcp-x',
    'sh',
    '-c',
    'true',
  ]);
});

test('runningInspectArgs: inspect the Running state', () => {
  assert.deepEqual(runningInspectArgs('run-1-mcp-x'), [
    'inspect',
    '-f',
    '{{.State.Running}}',
    'run-1-mcp-x',
  ]);
});

test('volumeInspectArgs: inspect a docker volume', () => {
  assert.deepEqual(volumeInspectArgs('omniroute-data'), [
    'volume',
    'inspect',
    'omniroute-data',
  ]);
});

test('volumeCreateArgs: create a docker volume', () => {
  assert.deepEqual(volumeCreateArgs('omniroute-data'), [
    'volume',
    'create',
    'omniroute-data',
  ]);
});

test('volumeCopyOutArgs: volume -> host dir via alpine cp', () => {
  assert.deepEqual(volumeCopyOutArgs('omniroute-data', '/tmp/out'), [
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

test('volumeCopyInArgs: host dir -> volume without a wipe guard', () => {
  assert.deepEqual(volumeCopyInArgs('/tmp/in', 'omniroute-data'), [
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

test('volumeCopyInArgs: wipe=true prepends the destructive rm guard', () => {
  assert.deepEqual(volumeCopyInArgs('/tmp/in', 'omniroute-data', true), [
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

test('waitArgs blocks on a container and prints its exit code', () => {
  assert.deepEqual(waitArgs('abc123'), ['wait', 'abc123']);
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
    };
    child.stdout = new PassThrough();
    setImmediate(() => {
      if (script.stdout !== undefined) child.stdout.write(script.stdout);
      child.stdout.end();
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
