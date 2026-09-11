import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  resolveEngineSocketPath,
  runContainerPattern,
  UnixSocketEngineApi,
} from './containerApi.js';

test('resolveEngineSocketPath prefers DOCKER_HOST, then docker, then podman', () => {
  const existing = new Set([
    '/custom.sock',
    '/var/run/docker.sock',
    '/run/user/1000/podman/podman.sock',
  ]);
  const exists = (p: string) => existing.has(p);
  assert.equal(
    resolveEngineSocketPath({ DOCKER_HOST: 'unix:///custom.sock' }, exists),
    '/custom.sock'
  );
  assert.equal(
    resolveEngineSocketPath({ DOCKER_HOST: 'unix:///missing.sock' }, exists),
    undefined
  );
  assert.equal(
    resolveEngineSocketPath({ DOCKER_HOST: 'tcp://1.2.3.4:2375' }, exists),
    '/var/run/docker.sock'
  );
  assert.equal(resolveEngineSocketPath({}, exists), '/var/run/docker.sock');
  assert.equal(
    resolveEngineSocketPath(
      { XDG_RUNTIME_DIR: '/run/user/1000' },
      (p: string) => p.includes('podman')
    ),
    '/run/user/1000/podman/podman.sock'
  );
  assert.equal(
    resolveEngineSocketPath({}, () => false),
    undefined
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
