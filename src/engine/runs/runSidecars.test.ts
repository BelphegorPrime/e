import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ContainerRunner,
  SidecarSpec,
} from '../../ports/runtime/index.js';
import { FakeRuntime } from './runSpawn.testSupport.js';
import { isSidecarReady, waitForAllReady } from './runSidecars.js';

const spec = (over: Partial<SidecarSpec> = {}): SidecarSpec => ({
  name: 'e-demo-fix-1-mcp-everything',
  alias: 'everything',
  image: 'e-mcp-everything',
  port: 8080,
  network: 'e-demo-fix-1-net',
  ...over,
});

/** A runner whose probes answer from a script, counting how often each was asked. */
function probing(answers: {
  tcp?: boolean[];
  healthcheck?: boolean;
}): ContainerRunner & { tcpProbes: { network: string; host: string }[] } {
  const runner = new FakeRuntime() as FakeRuntime & {
    tcpProbes: { network: string; host: string }[];
  };
  runner.tcpProbes = [];
  const tcp = [...(answers.tcp ?? [true])];
  runner.probeTcp = (network: string, host: string): boolean => {
    runner.tcpProbes.push({ network, host });
    return tcp.length > 1 ? (tcp.shift() ?? false) : (tcp[0] ?? false);
  };
  runner.probeHealthcheck = (): boolean => answers.healthcheck ?? true;
  return runner;
}

test('a sidecar on a run network is probed at its alias', () => {
  const runner = probing({});
  assert.equal(isSidecarReady(runner, spec()), true);
  assert.deepEqual(runner.tcpProbes, [
    { network: 'e-demo-fix-1-net', host: 'everything' },
  ]);
});

test('in a shared netns the sidecar is probed on that namespace loopback', () => {
  // It has no alias of its own there: everyone is on the same loopback.
  const runner = probing({});
  isSidecarReady(runner, spec({ netns: 'e-egress', network: undefined }));
  assert.deepEqual(runner.tcpProbes, [
    { network: 'container:e-egress', host: '127.0.0.1' },
  ]);
});

test('a closed port is not ready, and the healthcheck is not even asked', () => {
  const runner = probing({ tcp: [false], healthcheck: true });
  let healthchecks = 0;
  runner.probeHealthcheck = (): boolean => {
    healthchecks += 1;
    return true;
  };
  assert.equal(isSidecarReady(runner, spec({ healthcheck: ['true'] })), false);
  assert.equal(healthchecks, 0);
});

test('an open port with a failing healthcheck is not ready', () => {
  const runner = probing({ tcp: [true], healthcheck: false });
  assert.equal(isSidecarReady(runner, spec({ healthcheck: ['true'] })), false);
});

test('waitForAllReady polls until a sidecar answers, sleeping between attempts', async () => {
  const runner = probing({ tcp: [false, false, true] });
  const sleeps: number[] = [];
  const result = await waitForAllReady(runner, [spec()], {
    attempts: 5,
    intervalMs: 50,
    sleep: async ms => {
      sleeps.push(ms);
    },
  });
  assert.deepEqual(
    result.ready.map(s => s.name),
    [spec().name]
  );
  assert.deepEqual(result.notReady, []);
  // Two misses, so two sleeps - the probe comes first, the sleep only on a miss.
  assert.deepEqual(sleeps, [50, 50]);
});

test('a sidecar that never comes up is reported, not thrown, after attempts run out', async () => {
  const runner = probing({ tcp: [false] });
  const sleeps: number[] = [];
  const result = await waitForAllReady(runner, [spec()], {
    attempts: 3,
    intervalMs: 10,
    sleep: async ms => {
      sleeps.push(ms);
    },
  });
  assert.deepEqual(result.ready, []);
  assert.deepEqual(
    result.notReady.map(s => s.name),
    [spec().name]
  );
  assert.equal(sleeps.length, 3, 'every attempt missed, so every one slept');
});

test('a ready sidecar never sleeps', async () => {
  const runner = probing({ tcp: [true] });
  const sleeps: number[] = [];
  await waitForAllReady(runner, [spec()], {
    attempts: 5,
    intervalMs: 10,
    sleep: async ms => {
      sleeps.push(ms);
    },
  });
  assert.deepEqual(sleeps, []);
});

test('waiting on no sidecars is a no-op', async () => {
  const runner = probing({});
  const result = await waitForAllReady(runner, [], {
    attempts: 5,
    intervalMs: 10,
    sleep: async () => {},
  });
  assert.deepEqual(result, { ready: [], notReady: [] });
});
