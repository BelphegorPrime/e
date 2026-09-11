import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createServeApp, startServeServer } from './serve.js';
import { TerminalSessions } from './terminalSessions.js';
import { fakeEngine, scriptedSpawner } from './terminalSessions.testSupport.js';
import {
  attachTerminalWebSocket,
  isOriginAllowed,
  TERMINAL_WS_PATH,
} from './terminalSocket.js';

test('isOriginAllowed accepts no Origin or the serving host only', () => {
  assert.equal(isOriginAllowed(undefined, '127.0.0.1:8080'), true);
  assert.equal(
    isOriginAllowed('http://127.0.0.1:8080', '127.0.0.1:8080'),
    true
  );
  assert.equal(isOriginAllowed('http://evil.test', '127.0.0.1:8080'), false);
  assert.equal(
    isOriginAllowed('http://127.0.0.1:9999', '127.0.0.1:8080'),
    false
  );
  assert.equal(isOriginAllowed('not a url', '127.0.0.1:8080'), false);
  assert.equal(isOriginAllowed('http://127.0.0.1:8080', undefined), false);
});

interface Frame {
  data: Buffer;
  isBinary: boolean;
}

/** A client whose frames are queued from creation, so none is missed. */
interface Client {
  socket: WebSocket;
  next(): Promise<Frame>;
}

function open(url: string, origin?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, origin ? { origin } : {});
    socket.binaryType = 'nodebuffer';
    const frames: Frame[] = [];
    const waiters: Array<(frame: Frame) => void> = [];
    socket.on('message', (data, isBinary) => {
      const frame = { data: data as Buffer, isBinary };
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    });
    const next = (): Promise<Frame> => {
      const queued = frames.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise(resolveFrame => waiters.push(resolveFrame));
    };
    socket.once('open', () => resolve({ socket, next }));
    socket.once('error', reject);
  });
}

test(
  'terminal WebSocket relays output, input and resize for one session',
  { timeout: 10_000 },
  async t => {
    const uiDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'e-ui-'));
    const spawner = scriptedSpawner();
    const engine = fakeEngine({});
    const sessions = new TerminalSessions({
      engine,
      spawnChild: spawner.spawn,
      pollIntervalMs: 5,
    });
    const server = await startServeServer(
      createServeApp(uiDirectory, { terminal: sessions, listAgents: () => [] }),
      '127.0.0.1',
      0
    );
    attachTerminalWebSocket(server, sessions);
    const clients: WebSocket[] = [];
    t.after(() => {
      for (const client of clients) client.terminate();
      sessions.dispose();
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const host = `127.0.0.1:${address.port}`;
    const wsBase = `ws://${host}${TERMINAL_WS_PATH}`;

    try {
      // Foreign origin: refused before the handshake completes.
      await assert.rejects(open(`${wsBase}?session=x`, 'http://evil.test'));
      // Any other path on the BFF port does not upgrade.
      await assert.rejects(open(`ws://${host}/api/other`));

      // Unknown session: closed with 4004.
      const unknown = await open(`${wsBase}?session=nope`, `http://${host}`);
      clients.push(unknown.socket);
      const closeCode = await new Promise<number>(resolve =>
        unknown.socket.once('close', code => resolve(code))
      );
      assert.equal(closeCode, 4004);

      const info = sessions.start({ agent: 'pi', name: 'demo' });
      spawner.children[0].stdout.write('building\n');
      await new Promise(resolve => setTimeout(resolve, 5));

      const client = await open(
        `${wsBase}?session=${info.id}`,
        `http://${host}`
      );
      const { socket } = client;
      clients.push(socket);
      // Replay first (binary), then the status frame (text).
      const replay = await client.next();
      assert.equal(replay.isBinary, true);
      assert.equal(replay.data.toString(), 'building\r\n');
      const status = await client.next();
      assert.equal(status.isBinary, false);
      assert.equal(
        (JSON.parse(status.data.toString()) as { type: string }).type,
        'status'
      );

      socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
      socket.send('garbage that is not json');
      engine.state.containers.push({ id: 'c1', name: 'e-pi-demo-1' });
      const attached = await client.next();
      assert.equal(
        (JSON.parse(attached.data.toString()) as { session: { phase: string } })
          .session.phase,
        'attached'
      );
      assert.deepEqual(engine.state.resizes, [
        { container: 'e-pi-demo-1', cols: 100, rows: 30 },
      ]);

      const typed: Buffer[] = [];
      engine.state.attached?.fromBrowser.on('data', chunk => typed.push(chunk));
      socket.send(Buffer.from('pwd\r'), { binary: true });
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(Buffer.concat(typed).toString(), 'pwd\r');

      engine.state.attached?.toBrowser.write('/workspace');
      const output = await client.next();
      assert.equal(output.isBinary, true);
      assert.equal(output.data.toString(), '/workspace');

      socket.close();
    } finally {
      // Cleanup runs in t.after so a failing assertion cannot leave the runner hanging.
    }
  }
);
