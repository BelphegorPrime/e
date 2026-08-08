import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContainerRuntime, type RunOptions } from './index';

// buildRunArgs is pure argv construction — no child process is spawned — so we
// exercise it directly on a concrete ContainerRuntime and assert the exact
// argument list. `command` is irrelevant here (it's the executable, not an
// arg), so any value does.
const runtime = new ContainerRuntime('docker');

function argsFor(
  opts: RunOptions,
  commandArgs: string[] = [],
  image = 'img',
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
    opts: { attach: true, name: 'run-1', workdir: '/workspace', network: 'run-1-net' },
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
      volume: ['/wt:/workspace', '/cache:/cache'],
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
      volume: ['/wt:/workspace'],
      port: ['8080:80'],
      env: ['K=v'],
    },
    ['claude', '-p', 'hi'],
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
