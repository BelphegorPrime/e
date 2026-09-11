import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  localSocketFromHost,
  resolveEngineSocketPath,
  runContainerPattern,
  UnixSocketEngineApi,
} from './containerApi.js';

test('resolveEngineSocketPath prefers DOCKER_HOST, then docker, then podman (Linux)', () => {
  const existing = new Set([
    '/custom.sock',
    '/var/run/docker.sock',
    '/run/user/1000/podman/podman.sock',
  ]);
  const exists = (p: string) => existing.has(p);
  const linux = (
    environment: Record<string, string | undefined>,
    probe: (p: string) => boolean = exists
  ) => resolveEngineSocketPath(environment, probe, 'linux', '/home/dev');
  assert.equal(linux({ DOCKER_HOST: 'unix:///custom.sock' }), '/custom.sock');
  assert.equal(linux({ DOCKER_HOST: 'unix:///missing.sock' }), undefined);
  assert.equal(
    linux({ DOCKER_HOST: 'tcp://1.2.3.4:2375' }),
    '/var/run/docker.sock'
  );
  assert.equal(linux({}), '/var/run/docker.sock');
  assert.equal(
    linux({ XDG_RUNTIME_DIR: '/run/user/1000' }, (p: string) =>
      p.includes('podman')
    ),
    '/run/user/1000/podman/podman.sock'
  );
  // Rootless Docker's user socket comes before the Podman user socket.
  assert.equal(
    linux({ XDG_RUNTIME_DIR: '/run/user/1000' }, (p: string) =>
      p.startsWith('/run/user/1000/')
    ),
    '/run/user/1000/docker.sock'
  );
  assert.equal(
    linux({}, () => false),
    undefined
  );
});

test("resolveEngineSocketPath honours Podman's CONTAINER_HOST after DOCKER_HOST", () => {
  const exists = (p: string) => p === '/podman.sock';
  assert.equal(
    resolveEngineSocketPath(
      { CONTAINER_HOST: 'unix:///podman.sock' },
      exists,
      'linux',
      '/home/dev'
    ),
    '/podman.sock'
  );
  // A DOCKER_HOST that is a remote engine is skipped, CONTAINER_HOST still counts.
  assert.equal(
    resolveEngineSocketPath(
      { DOCKER_HOST: 'ssh://box', CONTAINER_HOST: 'unix:///podman.sock' },
      exists,
      'linux',
      '/home/dev'
    ),
    '/podman.sock'
  );
});

test('resolveEngineSocketPath probes the macOS desktop engines under the home dir', () => {
  const home = '/Users/dev';
  const mac = (present: string[]) =>
    resolveEngineSocketPath({}, p => present.includes(p), 'darwin', home);
  assert.equal(
    mac([`${home}/.docker/run/docker.sock`, '/var/run/docker.sock']),
    `${home}/.docker/run/docker.sock`
  );
  assert.equal(
    mac([`${home}/.orbstack/run/docker.sock`]),
    `${home}/.orbstack/run/docker.sock`
  );
  assert.equal(
    mac([`${home}/.colima/default/docker.sock`]),
    `${home}/.colima/default/docker.sock`
  );
  assert.equal(mac([`${home}/.rd/docker.sock`]), `${home}/.rd/docker.sock`);
  assert.equal(
    mac([`${home}/.local/share/containers/podman/machine/podman.sock`]),
    `${home}/.local/share/containers/podman/machine/podman.sock`
  );
  assert.equal(mac([]), undefined);
});

test('resolveEngineSocketPath uses named pipes on Windows, including DOCKER_HOST=npipe://', () => {
  const dockerPipe = '\\\\.\\pipe\\docker_engine';
  const podmanPipe = '\\\\.\\pipe\\podman-machine-default';
  assert.equal(
    localSocketFromHost('npipe:////./pipe/docker_engine'),
    dockerPipe
  );
  assert.equal(
    resolveEngineSocketPath(
      {},
      p => p === dockerPipe,
      'win32',
      'C:\\Users\\dev'
    ),
    dockerPipe
  );
  assert.equal(
    resolveEngineSocketPath(
      {},
      p => p === podmanPipe,
      'win32',
      'C:\\Users\\dev'
    ),
    podmanPipe
  );
  assert.equal(
    resolveEngineSocketPath(
      { DOCKER_HOST: 'npipe:////./pipe/custom' },
      p => p === '\\\\.\\pipe\\custom',
      'win32',
      'C:\\Users\\dev'
    ),
    '\\\\.\\pipe\\custom'
  );
});

test('runContainerPattern anchors the run name and escapes regex characters', () => {
  const pattern = new RegExp(runContainerPattern('smart.pi', 'fix-login'));
  assert.ok(pattern.test('/e-smart.pi-fix-login-1'));
  assert.ok(pattern.test('e-smart.pi-fix-login-12'));
  assert.ok(!pattern.test('/e-smartXpi-fix-login-1'));
  assert.ok(!pattern.test('/e-smart.pi-fix-login-extra-1'));
  assert.ok(!pattern.test('/e-smart.pi-fix-login-1-mcp-everything'));
});

/** A fake engine on a unix socket: list, attach (hijack) and resize. */
async function startFakeEngine(): Promise<{
  socketPath: string;
  close: () => Promise<void>;
  requests: string[];
  attached: () => import('node:stream').Duplex | undefined;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e-engine-'));
  const socketPath = path.join(dir, 'engine.sock');
  const requests: string[] = [];
  let attachedSocket: import('node:stream').Duplex | undefined;
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const url = new URL(request.url ?? '/', 'http://engine');
    if (url.pathname === '/containers/json') {
      const filters = JSON.parse(url.searchParams.get('filters') ?? '{}') as {
        name?: string[];
      };
      const pattern = new RegExp(filters.name?.[0] ?? '');
      const all = [
        { Id: 'aaa', Names: ['/e-pi-demo-1'] },
        { Id: 'bbb', Names: ['/e-pi-demo-extra-1'] },
      ];
      response.setHeader('content-type', 'application/json');
      // The engine's filter is a substring match; anchoring makes it exact.
      response.end(
        JSON.stringify(all.filter(c => c.Names.some(n => pattern.test(n))))
      );
      return;
    }
    if (url.pathname.endsWith('/resize')) {
      response.statusCode = 200;
      response.end();
      return;
    }
    if (url.pathname.endsWith('/attach')) {
      response.statusCode = 404;
      response.end('No such container');
      return;
    }
    response.statusCode = 500;
    response.end();
  });
  server.on('upgrade', (request, socket, head) => {
    requests.push(`UPGRADE ${request.url}`);
    if (request.url?.includes('/containers/missing/')) {
      socket.end(
        'HTTP/1.1 404 Not Found\r\nContent-Length: 17\r\n\r\nNo such container'
      );
      return;
    }
    socket.write(
      'HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'
    );
    if (head.length) socket.unshift(head);
    attachedSocket = socket;
    socket.write('hello from tty');
    socket.on('data', chunk => socket.write(`echo:${chunk.toString()}`));
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  return {
    socketPath,
    requests,
    attached: () => attachedSocket,
    close: () =>
      new Promise(resolve => {
        attachedSocket?.destroy();
        server.close(() => resolve());
      }),
  };
}

test('UnixSocketEngineApi lists by exact run name, hijacks attach and resizes', async () => {
  const engine = await startFakeEngine();
  const api = new UnixSocketEngineApi(engine.socketPath);
  try {
    const found = await api.findContainer(runContainerPattern('pi', 'demo'));
    assert.deepEqual(found, { id: 'aaa', name: 'e-pi-demo-1' });
    assert.equal(
      await api.findContainer(runContainerPattern('pi', 'nothing')),
      undefined
    );

    const stream = await api.attach('e-pi-demo-1');
    const received: Buffer[] = [];
    stream.on('data', chunk => received.push(chunk));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(Buffer.concat(received).toString(), 'hello from tty');
    stream.write('ls\r');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(Buffer.concat(received).toString(), 'hello from ttyecho:ls\r');
    stream.destroy();

    await api.resize('e-pi-demo-1', 120, 40);
    assert.ok(
      engine.requests.includes('POST /containers/e-pi-demo-1/resize?h=40&w=120')
    );

    await assert.rejects(api.attach('missing'), /HTTP 404.*No such container/);
  } finally {
    await engine.close();
  }
});
