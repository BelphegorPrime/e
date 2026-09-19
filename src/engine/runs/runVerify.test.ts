import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runVerify } from './runVerify.js';
import { FakeRuntime } from './runSpawn.testSupport.js';

/*
 * The verify gate (ADR-0016): the repository's own check, run as a second
 * container against the run's worktree, whose exit code is the run's verdict.
 * Driven through the ContainerRunner port - what reaches the port is the
 * contract, the engine argv is the port's own business.
 */

const params = {
  verify: { command: 'npm test' },
  worktreePath: '/tmp/worktrees/e-agent-slug-1',
  harnessImage: 'e-claude-code',
  containerName: 'e-agent-slug-1-verify',
};

test('runVerify: a check that exits 0 is green', async () => {
  const runtime = new FakeRuntime(0);
  const outcome = await runVerify({ runtime }, params);
  assert.equal(outcome.verdict, 'green');
});

test('runVerify: a check that exits non-zero is red, carrying its exit code', async () => {
  const runtime = new FakeRuntime(1);
  const outcome = await runVerify({ runtime }, params);
  assert.deepEqual(outcome, {
    verdict: 'red',
    exitCode: 1,
    reason: 'exit',
    output: '',
  });
});

test('runVerify: the check runs in the harness image, against the worktree, through sh -c', async () => {
  const runtime = new FakeRuntime(0);
  await runVerify({ runtime }, params);
  assert.equal(runtime.image, 'e-claude-code');
  assert.deepEqual(runtime.command, ['sh', '-c', 'npm test']);
  assert.deepEqual(runtime.options?.volumes, [
    { host: params.worktreePath, container: '/workspace' },
  ]);
  assert.equal(runtime.options?.workdir, '/workspace');
  assert.equal(runtime.options?.name, 'e-agent-slug-1-verify');
  assert.equal(runtime.options?.rm, true);
});

test('runVerify: a declared image replaces the harness image', async () => {
  const runtime = new FakeRuntime(0);
  await runVerify(
    { runtime },
    { ...params, verify: { command: 'go test ./...', image: 'golang:1.23' } }
  );
  assert.equal(runtime.image, 'golang:1.23');
});

test("runVerify: the check joins the run's egress containment, because it installs its own dependencies", async () => {
  const runtime = new FakeRuntime(0);
  await runVerify({ runtime }, { ...params, netns: 'e-egress-gateway' });
  assert.equal(runtime.options?.netns, 'e-egress-gateway');
});

test('runVerify: network: false takes the containment away', async () => {
  const runtime = new FakeRuntime(0);
  await runVerify(
    { runtime },
    {
      ...params,
      netns: 'e-egress-gateway',
      verify: { command: 'npm test', network: false },
    }
  );
  assert.equal(runtime.options?.netns, undefined);
  assert.equal(runtime.options?.networks, undefined);
});

test('runVerify: no credentials reach the check - it is not an agent', async () => {
  const runtime = new FakeRuntime(0);
  await runVerify({ runtime }, params);
  // A check that can reach the model can buy its way to green. VerifyParams
  // carries no env at all, so this is the type system's promise made visible.
  assert.equal(runtime.options?.env, undefined);
  assert.equal(runtime.options?.envFile, undefined);
});

test('runVerify: a check that never ran is broken, not red', async () => {
  for (const code of [125, 126, 127]) {
    const runtime = new FakeRuntime(code);
    const outcome = await runVerify({ runtime }, params);
    assert.equal(outcome.verdict, 'broken', String(code));
    assert.equal(outcome.exitCode, code);
  }
});

test('runVerify: a runtime that will not start is broken, and says why', async () => {
  const runtime = new FakeRuntime(0);
  runtime.run = async () => {
    throw new Error('Failed to start docker: spawn docker ENOENT');
  };
  const outcome = await runVerify({ runtime }, params);
  assert.equal(outcome.verdict, 'broken');
  assert.match(outcome.reason, /ENOENT/);
});

test(
  'runVerify: a check that outruns its timeout is red, and its container is removed',
  { timeout: 5000 },
  async () => {
    const runtime = new FakeRuntime(0);
    // A suite that never returns - often the infinite loop the agent just wrote,
    // which is why a timeout is the agent's to fix rather than a broken check.
    runtime.run = () => new Promise<number>(() => {});
    const outcome = await runVerify(
      { runtime },
      { ...params, verify: { command: 'npm test', timeoutMs: 5 } }
    );
    assert.deepEqual(outcome, {
      verdict: 'red',
      exitCode: 124,
      reason: 'timeout',
      output: '',
    });
    assert.deepEqual(runtime.removedContainers, ['e-agent-slug-1-verify']);
  }
);

test(
  'runVerify: without a declared timeout the check is not timed out',
  { timeout: 5000 },
  async () => {
    const runtime = new FakeRuntime(0);
    let settle: (code: number) => void = () => {};
    runtime.run = () => new Promise<number>(r => (settle = r));
    const pending = runVerify({ runtime }, params);
    setTimeout(() => settle(0), 20);
    assert.equal((await pending).verdict, 'green');
    assert.deepEqual(runtime.removedContainers, []);
  }
);

test('runVerify: no cache by default - nothing outside the worktree is mounted', async () => {
  const runtime = new FakeRuntime(0);
  await runVerify({ runtime }, params);
  assert.deepEqual(runtime.options?.volumes, [
    { host: params.worktreePath, container: '/workspace' },
  ]);
  assert.deepEqual(runtime.createdVolumes, []);
});

test('runVerify: cache mounts a per-Store named volume the package managers are pointed at', async () => {
  const runtime = new FakeRuntime(0);
  await runVerify(
    { runtime },
    {
      ...params,
      verify: { command: 'npm ci && npm test', cache: true },
      cacheVolume: 'e-verify-cache-abc123',
    }
  );
  assert.deepEqual(runtime.createdVolumes, ['e-verify-cache-abc123']);
  assert.deepEqual(runtime.options?.volumes, [
    { host: params.worktreePath, container: '/workspace' },
    { host: 'e-verify-cache-abc123', container: '/cache' },
  ]);
  // A mount nothing reads is decoration: the cache only bites if the package
  // managers are told where it is.
  assert.deepEqual(runtime.options?.env, [
    'npm_config_cache=/cache/npm',
    'PIP_CACHE_DIR=/cache/pip',
    'YARN_CACHE_FOLDER=/cache/yarn',
  ]);
});

test('runVerify: cache without a volume name mounts nothing', async () => {
  const runtime = new FakeRuntime(0);
  await runVerify(
    { runtime },
    { ...params, verify: { command: 'npm test', cache: true } }
  );
  assert.deepEqual(runtime.createdVolumes, []);
  assert.equal(runtime.options?.volumes?.length, 1);
});

test('runVerify: the verdict carries the output, because the next iteration is told it', async () => {
  const runtime = new FakeRuntime(1);
  runtime.outputs = ['FAIL src/auth.test.ts\n  expected 200, got 401'];
  const outcome = await runVerify({ runtime }, params);
  assert.match(outcome.output, /expected 200, got 401/);
});

test('runVerify: a green check carries its output too - nothing reads it, but nothing has to guess', async () => {
  const runtime = new FakeRuntime(0);
  runtime.outputs = ['12 passing'];
  assert.equal((await runVerify({ runtime }, params)).output, '12 passing');
});
