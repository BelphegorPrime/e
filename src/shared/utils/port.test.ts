import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { isPortInUse, resolveFreePort, resolveFreePortBlock } from './port.js';

const HOST = '127.0.0.1';

/** Occupies an OS-assigned port for the duration of `fn`. */
async function withOccupiedPort<T>(
  fn: (port: number) => Promise<T>
): Promise<T> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, HOST, resolve));
  const { port } = server.address() as net.AddressInfo;
  try {
    return await fn(port);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('isPortInUse reports an occupied port as in use', async () => {
  await withOccupiedPort(async port => {
    assert.equal(await isPortInUse(port, HOST), true);
  });
});

test('isPortInUse reports a released port as free again', async () => {
  const port = await withOccupiedPort(async port => port);
  assert.equal(await isPortInUse(port, HOST), false);
});

test('resolveFreePort returns the requested port when it is free', async () => {
  const port = await withOccupiedPort(async port => port);
  assert.equal(await resolveFreePort(port, { host: HOST }), port);
});

test('resolveFreePort returns the next free port above an occupied one', async () => {
  await withOccupiedPort(async port => {
    const resolved = await resolveFreePort(port, { host: HOST });
    assert.notEqual(resolved, port);
    assert.ok(resolved > port && resolved <= port + 100);
    assert.equal(await isPortInUse(resolved, HOST), false);
  });
});

test('resolveFreePort falls back to an ephemeral port when the scan is disabled', async () => {
  await withOccupiedPort(async port => {
    const resolved = await resolveFreePort(port, { host: HOST, scanRange: 0 });
    assert.notEqual(resolved, port);
    assert.ok(resolved > 0 && resolved <= 65535);
    assert.equal(await isPortInUse(resolved, HOST), false);
  });
});

test('port helpers reject out-of-range ports', async () => {
  await assert.rejects(() => isPortInUse(70000, HOST), RangeError);
  await assert.rejects(() => resolveFreePort(-1, { host: HOST }), RangeError);
  await assert.rejects(() => resolveFreePort(1.5, { host: HOST }), RangeError);
});

test('resolveFreePortBlock returns the requested start when the whole block is free', async () => {
  const port = await withOccupiedPort(async port => port);
  // The released port and its neighbour are almost certainly free; guard the
  // neighbour so the test cannot flake on a busy machine.
  if (await isPortInUse(port + 1, HOST)) return;
  assert.equal(await resolveFreePortBlock(port, 2, { host: HOST }), port);
});

test('resolveFreePortBlock moves the start when the second port is occupied', async () => {
  await withOccupiedPort(async occupied => {
    const start = occupied - 1;
    const resolved = await resolveFreePortBlock(start, 2, { host: HOST });
    assert.ok(
      resolved > occupied,
      `expected start above ${occupied}, got ${resolved}`
    );
    assert.equal(await isPortInUse(resolved, HOST), false);
    assert.equal(await isPortInUse(resolved + 1, HOST), false);
  });
});

test('resolveFreePortBlock falls back to an ephemeral block when the scan is disabled', async () => {
  await withOccupiedPort(async occupied => {
    const resolved = await resolveFreePortBlock(occupied, 2, {
      host: HOST,
      scanRange: 0,
    });
    assert.notEqual(resolved, occupied);
    assert.equal(await isPortInUse(resolved, HOST), false);
    assert.equal(await isPortInUse(resolved + 1, HOST), false);
  });
});

test('resolveFreePortBlock rejects an invalid block size', async () => {
  await assert.rejects(
    () => resolveFreePortBlock(8080, 0, { host: HOST }),
    RangeError
  );
});
