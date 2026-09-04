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
  composeUpArgs,
  composeWaitArgs,
  type RunOptions,
  type SidecarSpec,
} from './index';

// buildRunArgs is pure argv construction — no child process is spawned — so we
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
    name: 'attached: no -d',
    opts: { attach: true },
    expected: ['run', 'img'],
  },
  {
    name: 'detached: -d is added',
    opts: { attach: false },
    expected: ['run', '-d', 'img'],
  },
  {
    name: 'attach undefined defaults to detached (-d present)',
    opts: {},
    expected: ['run', '-d', 'img'],
  },
  {
    name: '--rm / --name / -w in order',
    opts: { attach: true, rm: true, name: 'run-1', workdir: '/workspace' },
    expected: ['run', '--rm', '--name', 'run-1', '-w', '/workspace', 'img'],
  },
  {
    name: '--network follows -w, before env-files',
    opts: {
      attach: true,
      name: 'run-1',
      workdir: '/workspace',
      network: 'run-1-net',
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
    name: '--env-file entries keep their order',
    opts: { attach: true, envFile: ['/base.env', '/user.env'] },
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
      attach: true,
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

test('buildRunArgs: full ordering — flags, env-files, v/p/e, image, then command args', () => {
  const args = argsFor(
    {
      attach: false,
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
    '-d',
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
  assert.deepEqual(argsFor({ attach: true }, ['sh', '-c', 'echo hi']), [
    'run',
    'img',
    'sh',
    '-c',
    'echo hi',
  ]);
});

test('buildRunArgs: adds host gateway mapping for local Compose services', () => {
  assert.deepEqual(
    argsFor({ extraHosts: ['host.docker.internal:host-gateway'] }),
    ['run', '-d', '--add-host', 'host.docker.internal:host-gateway', 'img']
  );
});

test('composeUpArgs: starts the selected Compose file detached', () => {
  assert.deepEqual(composeUpArgs('/project/.e/compose.yaml'), [
    'compose',
    '-f',
    '/project/.e/compose.yaml',
    'up',
    '-d',
  ]);
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


// --- structured mounts ---

test('formatMount: read-write omits :ro', () => {
  assert.equal(
    formatMount({ host: '/wt', container: '/workspace' }),
    '/wt:/workspace'
  );
});

test('formatMount: ro appends :ro', () => {
  assert.equal(
    formatMount({ host: '/s', container: '/root/.claude/skills/x', ro: true }),
    '/s:/root/.claude/skills/x:ro'
  );
});

test('buildRunArgs: a read-only mount renders host:container:ro', () => {
  assert.deepEqual(
    argsFor({
      attach: true,
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
    'sh',
    '-c',
    'nc -w 2 everything 3001 < /dev/null',
  ]);
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
