import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Waker, realSleep, untilTime, type Sleep } from './clock.js';

/*
 * The coordinator's clock: one wait, cut short by a wake or a stop, that a
 * test drives with an injected clock instead of real time.
 */

test('realSleep: waits, and an abort cuts it short without a rejection', async () => {
  const started = Date.now();
  await realSleep(5, new AbortController().signal);
  assert.ok(Date.now() - started >= 4);

  const stop = new AbortController();
  const waiting = realSleep(60_000, stop.signal);
  stop.abort();
  await waiting;

  const gone = new AbortController();
  gone.abort();
  await realSleep(60_000, gone.signal);
});

test('untilTime: reached on the injected clock, re-checked after every wait', async () => {
  let t = 0;
  const asked: number[] = [];
  const sleep: Sleep = async ms => {
    asked.push(ms);
    // A clock that moves less than asked: the wait is taken again.
    t += Math.ceil(ms / 2);
  };
  const reached = await untilTime(
    100,
    { now: () => new Date(t), sleep },
    new AbortController().signal
  );
  assert.equal(reached, true);
  assert.ok(t >= 100);
  assert.deepEqual(asked.slice(0, 2), [100, 50]);
});

test('untilTime: a stop ends the wait as not reached', async () => {
  const stop = new AbortController();
  const waiting = untilTime(
    Date.now() + 60_000,
    { now: () => new Date(), sleep: realSleep },
    stop.signal
  );
  stop.abort();
  assert.equal(await waiting, false);
});

test('Waker: a wake ends the sleep, and one that lands between sleeps is kept', async () => {
  const waker = new Waker();
  const sleeping = waker.sleep(60_000);
  waker.wake();
  await sleeping;

  // Nobody is asleep: the next sleep returns at once, and only that one.
  waker.wake();
  await waker.sleep(60_000);
  const started = Date.now();
  await waker.sleep(5);
  assert.ok(Date.now() - started >= 4);
});
