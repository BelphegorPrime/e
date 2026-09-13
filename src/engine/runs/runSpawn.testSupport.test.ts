import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeRuntime, makeSleep } from './runSpawn.testSupport.js';

test('makeSleep records the requested wait without serving it', async () => {
  const runtime = new FakeRuntime();
  const sleep = makeSleep(runtime);
  await sleep(1000);
  await sleep(50);
  assert.deepEqual(runtime.sleeps, [1000, 50]);
});

test('makeSleep yields, so a tight poll loop cannot starve a timer', async () => {
  // The regression: an `async` function with no `await` resolves as a bare
  // microtask, and a loop of `tick(); await sleep()` then monopolises the
  // microtask queue - timers and socket callbacks in the same test never run.
  const runtime = new FakeRuntime();
  const sleep = makeSleep(runtime);

  let timerFired = false;
  const timer = setTimeout(() => {
    timerFired = true;
  }, 0);

  for (let poll = 0; poll < 50; poll++) await sleep(1);
  clearTimeout(timer);

  assert.equal(
    timerFired,
    true,
    'a timer armed before the loop must get a turn during it'
  );
  assert.equal(runtime.sleeps.length, 50);
});

test('makeSleep lets real I/O complete alongside a poll loop', async () => {
  const runtime = new FakeRuntime();
  const sleep = makeSleep(runtime);

  const http = await import('node:http');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    let polling = true;
    const loop = (async () => {
      while (polling) await sleep(1);
    })();
    // With a microtask-only sleep this request never resolves and the test
    // times out; the loop has to hand control back between polls.
    const answer = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(await answer.text(), 'ok');
    polling = false;
    await loop;
    assert.ok(runtime.sleeps.length > 0, 'the loop really was running');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
