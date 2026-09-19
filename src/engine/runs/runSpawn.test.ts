import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { InMemoryGit } from '../../ports/git/memory.js';
import type { PullRequest, PullRequestSpec } from '../../ports/github/index.js';
import type { Harness } from '../../core/harness/index.js';
import type { Agent } from '../../core/agent/index.js';
import {
  runSpawn,
  RUN_GIT_INSTRUCTIONS,
  launchPrompt,
  type RunSpawnDeps,
  type RunSpawnParams,
} from './runSpawn.js';
import { slugify } from '../../core/identity/slugify.js';
import {
  FakeRuntime,
  demoAgent,
  demoHarness,
  makeSleep,
  seedParentArtifacts,
} from './runSpawn.testSupport.js';
import { defaultBrokerPlan, type SidecarPlan } from '../sidecarPlan.js';
import {
  ensureSpool,
  readRecord,
  readRunInfo,
  readStatus,
  writeRequest,
  writeStatus,
} from '../../sidecars/broker/contract/spool.js';
import type { ChildLaunch, ChildLauncher } from './childRun.js';
import { Env } from '../../shared/utils/env.js';
import { DEFAULT_LOOP_CAPS } from '../../core/store/config.js';

/** A `PullRequest` fake that records what the orchestrator asked it to open. */
class FakePullRequest implements PullRequest {
  url?: string;
  fails?: string;
  specs: PullRequestSpec[] = [];

  constructor(opts: { url?: string; fails?: string } = {}) {
    this.url = opts.url;
    this.fails = opts.fails;
  }

  create(spec: PullRequestSpec): string {
    this.specs.push(spec);
    if (this.fails) throw new Error(this.fails);
    return this.url ?? `https://example.com/pr/${spec.head}`;
  }
}

const harness = demoHarness;
const agent = demoAgent;

function makeDeps(overrides: Partial<RunSpawnDeps> = {}) {
  const git = overrides.git ?? new InMemoryGit();
  const runtime = (overrides.runtime ?? new FakeRuntime()) as FakeRuntime;
  const deps: RunSpawnDeps = {
    git,
    runtime,
    pullRequest: overrides.pullRequest,
    // Instant, recorded sleep so readiness polling never actually waits.
    sleep: overrides.sleep ?? makeSleep(runtime),
  };
  return { deps, git: git as InMemoryGit, runtime };
}

/**
 * A broker run must say how siblings are launched; tests that expect none get
 * a launcher that fails loudly. (The production launcher re-invokes the CLI,
 * which under the test runner would be this very file: never let that happen.)
 */
const noSiblingsExpected: ChildLauncher = launch => {
  throw new Error(`unexpected sibling launch for ${launch.request.id}`);
};

function makeParams(overrides: Partial<RunSpawnParams> = {}): RunSpawnParams {
  return {
    agent,
    harness,
    prompt: 'Fix the flaky test',
    imageTag: 'e-harness-demo',
    runOptions: { rm: true },
    worktreesDir: '/tmp/e-worktrees',
    siblingHost: { launch: noSiblingsExpected },
    ...overrides,
  };
}

/** A demo sidecar plan; a few fast readiness attempts keep the tests instant. */
const sidecar: SidecarPlan = {
  alias: 'everything',
  image: 'e-mcp-everything',
  port: 3001,
};
const fastReadiness = { attempts: 3, intervalMs: 1 };

test('creates a worktree from HEAD on branch e/<harness>/<slug>-1 and runs the harness', async () => {
  const { deps, git, runtime } = makeDeps();
  const result = await runSpawn(deps, makeParams());

  const slug = slugify('Fix the flaky test');
  assert.equal(git.worktrees.length, 1);
  assert.equal(git.worktrees[0].branch, `e/demo/${slug}-1`);
  assert.equal(git.worktrees[0].base, 'basesha');

  assert.equal(runtime.ran, true);
  assert.equal(runtime.image, 'e-harness-demo');
  assert.equal(runtime.options?.name, `e-demo-${slug}-1`);
  assert.equal(runtime.options?.workdir, '/workspace');
  assert.deepEqual(runtime.options?.volumes, [
    { host: git.worktrees[0].path, container: '/workspace' },
  ]);
  assert.deepEqual(runtime.command, [
    'demo',
    '-p',
    launchPrompt('Fix the flaky test'),
  ]);

  assert.equal(result.ran, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.branch, `e/demo/${slug}-1`);
});

test('the run branch uses the agent name, while the image stays the harness image', async () => {
  const { deps, git, runtime } = makeDeps();
  const smart: Agent = { name: 'smart-demo', harness: 'demo' };
  const result = await runSpawn(deps, makeParams({ agent: smart }));

  const slug = slugify('Fix the flaky test');
  assert.equal(result.branch, `e/smart-demo/${slug}-1`);
  assert.equal(git.listedPrefixes[0], `e/smart-demo/${slug}`);
  // The run executes the imageTag it was given (the harness base here).
  assert.equal(runtime.image, 'e-harness-demo');
});

test('runs the imageTag it is given (e.g. a derived agent image)', async () => {
  const { deps, runtime } = makeDeps();
  await runSpawn(deps, makeParams({ imageTag: 'e-agent-smart-codex' }));
  assert.equal(runtime.image, 'e-agent-smart-codex');
});

test('threads a runtime-resolved model into the harness command', async () => {
  const { deps, runtime } = makeDeps();
  // A harness that takes the model as a command flag (like Codex `-m`).
  const codexish: Harness = {
    ...harness,
    buildCommand: (prompt, model) =>
      model
        ? ['codex', 'exec', '-m', model, prompt]
        : ['codex', 'exec', prompt],
  };
  await runSpawn(deps, makeParams({ harness: codexish, model: 'gpt-5-codex' }));
  assert.deepEqual(runtime.command, [
    'codex',
    'exec',
    '-m',
    'gpt-5-codex',
    launchPrompt('Fix the flaky test'),
  ]);
});

test('interactive mode starts the harness TUI and ignores the one-shot prompt', async () => {
  const { deps, runtime } = makeDeps();
  const interactiveHarness: Harness = {
    ...harness,
    buildInteractiveCommand: model =>
      model ? ['demo', 'tui', '-m', model] : ['demo', 'tui'],
  };

  await runSpawn(
    deps,
    makeParams({
      harness: interactiveHarness,
      interactive: true,
      model: 'demo-pro',
    })
  );

  assert.deepEqual(runtime.command, ['demo', 'tui', '-m', 'demo-pro']);
});

test('does not modify the working tree in place: worktree lives under worktreesDir', async () => {
  const { deps, git } = makeDeps();
  await runSpawn(deps, makeParams({ worktreesDir: '/tmp/wt' }));
  // Containment via path.relative: Windows joins '/tmp/wt' as '\\tmp\\wt'.
  const relative = path.relative('/tmp/wt', git.worktrees[0].path);
  assert.ok(
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative),
    `${git.worktrees[0].path} should live under /tmp/wt`
  );
});

test('commits when the worktree is dirty', async () => {
  const { deps, git } = makeDeps({ git: new InMemoryGit({ dirty: true }) });
  const result = await runSpawn(deps, makeParams());
  assert.equal(git.commits.length, 1);
  assert.equal(git.commits[0].path, git.worktrees[0].path);
  assert.equal(result.captured, true);
});

test('leaves the agent commits alone when the worktree is clean', async () => {
  const { deps, git } = makeDeps({ git: new InMemoryGit({ dirty: false }) });
  await runSpawn(deps, makeParams());
  assert.equal(git.commits.length, 0);
});

test('always removes the worktree and keeps the branch, even on a clean exit-0 run', async () => {
  const { deps, git } = makeDeps();
  await runSpawn(deps, makeParams());
  assert.deepEqual(git.removedWorktrees, [git.worktrees[0].path]);
});

test('removes the worktree even when the agent exits non-zero, and preserves the exit code', async () => {
  const { deps, git } = makeDeps({ runtime: new FakeRuntime(2) });
  const result = await runSpawn(deps, makeParams());
  assert.equal(result.exitCode, 2);
  assert.deepEqual(git.removedWorktrees, [git.worktrees[0].path]);
  assert.equal(git.commits.length, 0);
});

test('never force-removes a worktree that is still dirty: a commit failure leaves the work in place', async () => {
  const { deps, git } = makeDeps({
    git: new InMemoryGit({
      dirty: true,
      fail: { commitAll: 'pre-commit hook failed' },
    }),
  });
  await assert.rejects(runSpawn(deps, makeParams()), /pre-commit hook failed/);
  assert.deepEqual(git.removedWorktrees, []);
  // The failed commit leaves the worktree as it was: still dirty, still there.
  assert.equal(git.isDirty(git.worktrees[0]!.path), true);
});

test('--name overrides the slug and flows into the branch', async () => {
  const { deps, git } = makeDeps();
  const result = await runSpawn(deps, makeParams({ name: 'my-custom-run' }));
  assert.equal(git.worktrees[0].branch, 'e/demo/my-custom-run-1');
  assert.equal(result.branch, 'e/demo/my-custom-run-1');
});

test('numbers the run from the next counter after existing branches', async () => {
  const slug = slugify('Fix the flaky test');
  const { deps, git } = makeDeps({
    git: new InMemoryGit({
      branches: [`e/demo/${slug}-1`, `e/demo/${slug}-2`],
    }),
  });
  const result = await runSpawn(deps, makeParams());
  assert.equal(git.listedPrefixes[0], `e/demo/${slug}`);
  assert.equal(result.branch, `e/demo/${slug}-3`);
});

test('counter considers remote-tracking branches', async () => {
  const slug = slugify('Fix the flaky test');
  const { deps } = makeDeps({
    git: new InMemoryGit({ branches: [`origin/e/demo/${slug}-4`] }),
  });
  const result = await runSpawn(deps, makeParams());
  assert.equal(result.branch, `e/demo/${slug}-5`);
});

test('bumps the counter and retries on an atomic-create collision', async () => {
  const slug = slugify('Fix the flaky test');
  const { deps, git } = makeDeps({
    // A concurrent spawn already took -1 between our enumeration and create.
    git: new InMemoryGit({ collide: [`e/demo/${slug}-1`] }),
  });
  const result = await runSpawn(deps, makeParams());

  assert.equal(result.branch, `e/demo/${slug}-2`);
  assert.equal(git.worktrees.length, 1);
  assert.equal(git.worktrees[0].branch, `e/demo/${slug}-2`);
  assert.equal(git.calls.filter(c => c === 'addWorktree').length, 2);
});

test('rethrows a non-collision worktree failure immediately without retrying', async () => {
  const { deps, git } = makeDeps({
    git: new InMemoryGit({ fail: { addWorktree: 'fatal: permission denied' } }),
  });
  await assert.rejects(runSpawn(deps, makeParams()), /permission denied/);
  // Exactly one attempt - no counter-bump storm on a genuine error.
  assert.equal(git.calls.filter(c => c === 'addWorktree').length, 1);
});

test('pushes the branch to origin when the run exits 0 with commits', async () => {
  const { deps, git } = makeDeps();
  const result = await runSpawn(deps, makeParams());
  assert.deepEqual(git.pushed, [result.branch]);
  assert.equal(result.pushed, true);
});

test('a run that exited non-zero still pushes what it committed (ADR-0016)', async () => {
  // The push used to hang on the harness's exit code. It now hangs on whether
  // there is anything to push: an exhausted or crashed run's attempts are
  // exactly what a human needs to read, and uncommitted work never travels.
  const { deps, git, runtime } = makeDeps({ runtime: new FakeRuntime(1) });
  const result = await runSpawn(deps, makeParams());
  assert.equal(result.pushed, true);
  assert.deepEqual(git.pushed, [result.branch]);
  assert.equal(runtime.runs.length, 1);
});

test('a run that exited non-zero and committed nothing pushes nothing', async () => {
  const { deps, git } = makeDeps({
    runtime: new FakeRuntime(1),
    git: new InMemoryGit({ hasCommitsBeyondBase: false }),
  });
  const result = await runSpawn(deps, makeParams());
  assert.equal(git.pushed.length, 0);
  assert.ok(!git.calls.includes('push'));
  assert.equal(result.pushed, false);
});

test('does not push when the run exits 0 but produced no commits', async () => {
  const { deps, git } = makeDeps({
    git: new InMemoryGit({ hasCommitsBeyondBase: false }),
  });
  const result = await runSpawn(deps, makeParams());
  assert.equal(git.pushed.length, 0);
  assert.equal(result.pushed, false);
});

test('a push failure is non-fatal: branch kept, warning surfaced, exit code unchanged', async () => {
  const { deps, git } = makeDeps({
    git: new InMemoryGit({ fail: { push: 'no configured remote' } }),
  });
  const result = await runSpawn(deps, makeParams());

  assert.equal(result.exitCode, 0);
  assert.equal(result.pushed, false);
  assert.match(result.pushWarning ?? '', /no configured remote/);
  assert.equal(git.pushed.length, 0);
  // The worktree is still cleaned up and the branch (locally) preserved.
  assert.deepEqual(git.removedWorktrees, [git.worktrees[0].path]);
});

// --- PR/MR creation after a successful push -----------------------------------

test('opens a PR/MR into the spawn-time branch when a platform is configured', async () => {
  const pr = new FakePullRequest({ url: 'https://github.com/o/r/pull/7' });
  const { deps, git } = makeDeps({ pullRequest: pr });
  const result = await runSpawn(deps, makeParams({ gitPlatform: 'github' }));

  assert.equal(result.pullRequestUrl, 'https://github.com/o/r/pull/7');
  assert.equal(pr.specs.length, 1);
  const spec = pr.specs[0];
  assert.equal(spec.platform, 'github');
  assert.equal(spec.head, result.branch);
  // The target branch is the branch the host was on when the run spawned.
  assert.equal(spec.base, 'main');
  // The title is the run branch's tip commit subject (its commit message).
  assert.equal(spec.title, `e: run output for ${result.branch}`);
  // The body is the prompt that drove the run.
  assert.equal(spec.body, 'Fix the flaky test');
  assert.deepEqual(git.pushed, [result.branch]);
});

test('titles the PR/MR with the run git log tip when one exists', async () => {
  const pr = new FakePullRequest();
  const git = new InMemoryGit({
    log: [
      { sha: 'c2', subject: 'feat: fix the flaky test', committerDate: 't2' },
      { sha: 'c1', subject: 'base', committerDate: 't1' },
    ],
  });
  const { deps } = makeDeps({ git, pullRequest: pr });
  await runSpawn(deps, makeParams({ gitPlatform: 'github' }));
  assert.equal(pr.specs[0].title, 'feat: fix the flaky test');
});

test('skips PR/MR creation when no platform is configured', async () => {
  const pr = new FakePullRequest();
  const { deps } = makeDeps({ pullRequest: pr });
  const result = await runSpawn(deps, makeParams());
  assert.equal(pr.specs.length, 0);
  assert.equal(result.pullRequestUrl, undefined);
  assert.equal(result.pullRequestWarning, undefined);
  // The push still happened as before.
  assert.equal(result.pushed, true);
});

test('a PR/MR failure is non-fatal: warning surfaced, push/exit code unchanged', async () => {
  const pr = new FakePullRequest({ fails: 'no auth found' });
  const { deps } = makeDeps({ pullRequest: pr });
  const result = await runSpawn(deps, makeParams({ gitPlatform: 'gitlab' }));

  assert.equal(result.exitCode, 0);
  assert.equal(result.pushed, true);
  assert.equal(result.pullRequestUrl, undefined);
  assert.match(result.pullRequestWarning ?? '', /no auth found/);
  assert.equal(pr.specs.length, 1);
  assert.equal(pr.specs[0].platform, 'gitlab');
});

test('no PR/MR without a push (push failure leaves nothing to open)', async () => {
  const pr = new FakePullRequest();
  const { deps } = makeDeps({
    git: new InMemoryGit({ fail: { push: 'no remote' } }),
    pullRequest: pr,
  });
  const result = await runSpawn(deps, makeParams({ gitPlatform: 'github' }));
  assert.equal(pr.specs.length, 0);
  assert.equal(result.pullRequestUrl, undefined);
});

// --- Composed run group (ADR-0005 / issue #13) ---------------------------------

test('regression: with no sidecars the run behaves exactly as before (no group calls)', async () => {
  const { deps, runtime } = makeDeps();
  const result = await runSpawn(deps, makeParams());

  assert.equal(result.ran, true);
  assert.equal(result.exitCode, 0);
  assert.equal(runtime.options?.networks, undefined);
  assert.deepEqual(runtime.calls, ['run']);
  assert.equal(runtime.networks.length, 0);
  assert.equal(runtime.startedSidecars.length, 0);
});

test('hands the sidecar its own credential env-file and never a phantom mcp.json', async () => {
  const { deps, runtime } = makeDeps();
  await runSpawn(
    deps,
    makeParams({
      sidecars: [{ ...sidecar, envFile: ['/tmp/scratch/everything.env'] }],
      readiness: fastReadiness,
    })
  );
  assert.deepEqual(runtime.startedSidecars[0].envFile, [
    '/tmp/scratch/everything.env',
  ]);

  // No credentials: no --env-file at all (docker rejects a missing file).
  const plain = makeDeps();
  await runSpawn(
    plain.deps,
    makeParams({ sidecars: [sidecar], readiness: fastReadiness })
  );
  assert.equal(plain.runtime.startedSidecars[0].envFile, undefined);
});

test('with the egress netns, sidecars join it, are probed on its loopback, and no run network is created', async () => {
  const { deps, runtime } = makeDeps();
  const result = await runSpawn(
    deps,
    makeParams({
      sidecars: [sidecar],
      readiness: fastReadiness,
      runOptions: { rm: true, netns: 'e-egress' },
    })
  );
  assert.equal(result.ran, true);
  assert.deepEqual(runtime.networks, []);
  assert.deepEqual(runtime.removedNetworks, []);
  assert.equal(runtime.startedSidecars[0].netns, 'e-egress');
  assert.equal(runtime.startedSidecars[0].network, undefined);
  assert.deepEqual(runtime.probedNetworks, ['container:e-egress 127.0.0.1']);
  assert.equal(runtime.options?.netns, 'e-egress');
});

test('counter ignores sibling slugs that merely share the prefix and counts any remote', async () => {
  const slug = slugify('Fix the flaky test');
  const { deps } = makeDeps({
    git: new InMemoryGit({
      branches: [
        `e/demo/${slug}-typo-9`,
        `upstream/e/demo/${slug}-2`,
        `e/demo/${slug}-1`,
      ],
    }),
  });
  const result = await runSpawn(deps, makeParams());
  assert.equal(result.branch, `e/demo/${slug}-3`);
});

test('brings up the group in order: network → sidecar → probe → agent → teardown', async () => {
  const { deps, git, runtime } = makeDeps();
  await runSpawn(
    deps,
    makeParams({ sidecars: [sidecar], readiness: fastReadiness })
  );

  assert.deepEqual(runtime.calls, [
    'createNetwork',
    'startSidecar',
    'probeTcp',
    'isRunning',
    'run',
    'removeContainer',
    'removeNetwork',
  ]);
  // Teardown order and identifiers.
  const runName = git.worktrees[0].branch.replace(/\//g, '-');
  assert.deepEqual(runtime.networks, [`${runName}-net`]);
  assert.deepEqual(runtime.removedNetworks, [`${runName}-net`]);
  assert.deepEqual(runtime.removedContainers, [`${runName}-mcp-everything`]);
});

test('the agent joins the run network and the sidecar gets a unique name + alias', async () => {
  const { deps, git, runtime } = makeDeps();
  await runSpawn(
    deps,
    makeParams({ sidecars: [sidecar], readiness: fastReadiness })
  );
  const runName = git.worktrees[0].branch.replace(/\//g, '-');

  assert.deepEqual(runtime.options?.networks, [`${runName}-net`]);
  const spec = runtime.startedSidecars[0];
  assert.equal(spec.name, `${runName}-mcp-everything`);
  assert.equal(spec.alias, 'everything');
  assert.equal(spec.network, `${runName}-net`);
  assert.equal(spec.image, 'e-mcp-everything');
});

test('appends the harness MCP args to the container command', async () => {
  const { deps, runtime } = makeDeps();
  const mcpArgs = ['--mcp-config', '{"mcpServers":{}}'];
  await runSpawn(
    deps,
    makeParams({ sidecars: [sidecar], mcpArgs, readiness: fastReadiness })
  );
  assert.deepEqual(runtime.command, [
    'demo',
    '-p',
    launchPrompt('Fix the flaky test'),
    '--mcp-config',
    '{"mcpServers":{}}',
  ]);
});

test('waits across retries: probe fails twice then succeeds, agent then runs', async () => {
  const { deps, runtime } = makeDeps();
  runtime.tcpScript = { everything: [false, false, true] };
  const result = await runSpawn(
    deps,
    makeParams({
      sidecars: [sidecar],
      readiness: { attempts: 5, intervalMs: 10 },
    })
  );

  assert.equal(result.ran, true);
  assert.equal(runtime.ran, true);
  // Two failed probes → slept exactly twice before the third succeeded.
  assert.deepEqual(runtime.sleeps, [10, 10]);
});

test('readiness miss aborts before the agent: no run, no commit, no push, group torn down', async () => {
  const { deps, git, runtime } = makeDeps();
  runtime.tcpScript = { everything: [false] }; // never ready
  const result = await runSpawn(
    deps,
    makeParams({ sidecars: [sidecar], readiness: fastReadiness })
  );

  assert.equal(result.ran, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.error ?? '', /everything/);
  assert.equal(runtime.ran, false);
  assert.ok(!git.calls.includes('commitAll'));
  assert.ok(!git.calls.includes('push'));
  // The whole group is still torn down, including the worktree.
  assert.deepEqual(runtime.removedContainers, [
    git.worktrees[0].branch.replace(/\//g, '-') + '-mcp-everything',
  ]);
  assert.equal(runtime.removedNetworks.length, 1);
  assert.deepEqual(git.removedWorktrees, [git.worktrees[0].path]);
});

test('readiness requires the healthcheck too: port open but healthcheck failing → miss', async () => {
  const { deps, runtime } = makeDeps();
  runtime.healthcheckResult = false;
  const withHealth: SidecarPlan = { ...sidecar, healthcheck: ['true'] };
  const result = await runSpawn(
    deps,
    makeParams({ sidecars: [withHealth], readiness: fastReadiness })
  );

  assert.equal(result.ran, false);
  assert.equal(runtime.ran, false);
  assert.ok(runtime.calls.includes('probeHealthcheck'));
});

test('createNetwork failure aborts fail-fast: no sidecar started, no agent, worktree torn down', async () => {
  const { deps, git, runtime } = makeDeps();
  runtime.throwOn = { op: 'createNetwork', message: 'network create denied' };
  await assert.rejects(
    runSpawn(
      deps,
      makeParams({ sidecars: [sidecar], readiness: fastReadiness })
    ),
    /network create denied/
  );
  assert.equal(runtime.startedSidecars.length, 0);
  assert.equal(runtime.ran, false);
  // The worktree existed by then, so it is still removed in the finally.
  assert.deepEqual(git.removedWorktrees, [git.worktrees[0].path]);
});

test('tears the group down even when the agent exits non-zero', async () => {
  const { deps, git, runtime } = makeDeps({ runtime: new FakeRuntime(2) });
  const result = await runSpawn(
    deps,
    makeParams({ sidecars: [sidecar], readiness: fastReadiness })
  );
  assert.equal(result.exitCode, 2);
  assert.equal(runtime.removedContainers.length, 1);
  assert.equal(runtime.removedNetworks.length, 1);
  assert.deepEqual(git.removedWorktrees, [git.worktrees[0].path]);
});

test('best-effort teardown never masks the run result when removal throws', async () => {
  const { deps, runtime } = makeDeps();
  runtime.throwOn = { op: 'removeContainer', message: 'rm boom' };
  const result = await runSpawn(
    deps,
    makeParams({ sidecars: [sidecar], readiness: fastReadiness })
  );
  // The run itself succeeded; the throwing teardown is swallowed.
  assert.equal(result.ran, true);
  assert.equal(result.exitCode, 0);
});

test('supports multiple sidecars: both started, both probed, both removed', async () => {
  const { deps, git, runtime } = makeDeps();
  const fs: SidecarPlan = {
    alias: 'filesystem',
    image: 'e-mcp-filesystem',
    port: 8000,
  };
  await runSpawn(
    deps,
    makeParams({ sidecars: [sidecar, fs], readiness: fastReadiness })
  );
  assert.equal(runtime.startedSidecars.length, 2);
  assert.equal(runtime.removedContainers.length, 2);
  const runName = git.worktrees[0].branch.replace(/\//g, '-');
  assert.deepEqual(
    runtime.startedSidecars.map(s => s.alias),
    ['everything', 'filesystem']
  );
  assert.deepEqual(runtime.removedContainers, [
    `${runName}-mcp-everything`,
    `${runName}-mcp-filesystem`,
  ]);
});

// The launch prompt carries the role contract (ADR-0013, ticket 01) between
// e's worktree rules and the task, so a one-shot agent is told to read
// $E_ROLE / $E_BROKER_URL and never to create marker files.
test('launchPrompt: worktree rules, then the role contract, then the task', () => {
  const prompt = launchPrompt('Fix the flaky test');
  assert.ok(prompt.startsWith(`${RUN_GIT_INSTRUCTIONS}\n`));
  assert.ok(prompt.endsWith('\n\nFix the flaky test'));
  assert.match(prompt, /role in this run is "parent"/);
  assert.match(prompt, /\$E_ROLE/);
  assert.match(prompt, /\$E_BROKER_URL/);
  assert.match(prompt, /do not create or rely on parent\/child marker files/);
});

test('a child run is launched with the child role named in its prompt', async () => {
  const { deps, runtime } = makeDeps();
  await runSpawn(deps, makeParams({ role: 'child' }));
  assert.deepEqual(runtime.command, [
    'demo',
    '-p',
    launchPrompt('Fix the flaky test', 'child'),
  ]);
  assert.match(runtime.command?.[2] ?? '', /role in this run is "child"/);
});

// The runtime-broker (ADR-0013) is one more sidecar, with the host-owned spool
// bind-mounted in. Its spool lives under the worktrees dir, so the tests give
// each run a throwaway one.
const brokerPlan = defaultBrokerPlan();

function withWorktreesDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-run-broker-'));
  return fn(dir).finally(() =>
    fs.rmSync(dir, { recursive: true, force: true })
  );
}

test('a planned broker starts as a sidecar on the run network with the spool mounted', async () => {
  await withWorktreesDir(async worktreesDir => {
    const { deps, runtime } = makeDeps();
    const result = await runSpawn(
      deps,
      makeParams({ worktreesDir, broker: brokerPlan, readiness: fastReadiness })
    );
    assert.equal(result.ran, true);

    const slug = slugify('Fix the flaky test');
    const runName = `e-demo-${slug}-1`;
    assert.deepEqual(runtime.networks, [`${runName}-net`]);
    assert.equal(runtime.startedSidecars.length, 1);
    const [spec] = runtime.startedSidecars;
    assert.equal(spec.name, `${runName}-broker`);
    assert.equal(spec.alias, 'runtime-broker');
    assert.equal(spec.image, 'e-broker');
    assert.equal(spec.port, 20130);
    assert.equal(spec.network, `${runName}-net`);
    assert.equal(spec.netns, undefined);
    assert.equal(spec.envFile, undefined);
    assert.deepEqual(spec.volumes, [
      {
        host: path.join(worktreesDir, '.broker', runName),
        container: '/var/lib/e-broker',
      },
    ]);
    // The agent joins the same network, so `runtime-broker` resolves for it.
    assert.deepEqual(runtime.options?.networks, [`${runName}-net`]);
    // Teardown: broker removed, network removed, spool gone.
    assert.deepEqual(runtime.removedContainers, [`${runName}-broker`]);
    assert.deepEqual(runtime.removedNetworks, [`${runName}-net`]);
    assert.equal(fs.existsSync(path.join(worktreesDir, '.broker')), true);
    assert.equal(
      fs.existsSync(path.join(worktreesDir, '.broker', runName)),
      false
    );
  });
});

test('the broker spool carries the run identity for GET /status; --keep-worktree keeps it', async () => {
  await withWorktreesDir(async worktreesDir => {
    const { deps } = makeDeps();
    await runSpawn(
      deps,
      makeParams({
        worktreesDir,
        broker: brokerPlan,
        readiness: fastReadiness,
        keepWorktree: true,
      })
    );
    const slug = slugify('Fix the flaky test');
    const spool = path.join(worktreesDir, '.broker', `e-demo-${slug}-1`);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(spool, 'run.json'), 'utf8')),
      {
        name: `e-demo-${slug}-1`,
        branch: `e/demo/${slug}-1`,
        agent: 'demo',
        role: 'parent',
        maxSiblings: 3,
      }
    );
    assert.ok(fs.statSync(path.join(spool, 'requests')).isDirectory());
    assert.ok(fs.statSync(path.join(spool, 'status')).isDirectory());
  });
});

test('with the local stack the broker shares the egress namespace like every sidecar', async () => {
  await withWorktreesDir(async worktreesDir => {
    const { deps, runtime } = makeDeps();
    await runSpawn(
      deps,
      makeParams({
        worktreesDir,
        broker: brokerPlan,
        readiness: fastReadiness,
        runOptions: { rm: true, netns: 'e-egress' },
      })
    );
    const [spec] = runtime.startedSidecars;
    assert.equal(spec.netns, 'e-egress');
    assert.equal(spec.network, undefined);
    assert.deepEqual(runtime.networks, []);
    // Readiness is probed on the namespace's loopback.
    assert.ok(runtime.probedNetworks.includes('container:e-egress 127.0.0.1'));
  });
});

test('a broker that never becomes ready fails the run before the agent starts', async () => {
  await withWorktreesDir(async worktreesDir => {
    const { deps, runtime } = makeDeps();
    runtime.tcpScript['runtime-broker'] = [false];
    const result = await runSpawn(
      deps,
      makeParams({ worktreesDir, broker: brokerPlan, readiness: fastReadiness })
    );
    assert.equal(result.ran, false);
    assert.match(
      result.error ?? '',
      /Sidecar "runtime-broker" did not become ready/
    );
    assert.equal(runtime.ran, false);
    assert.equal(fs.existsSync(path.join(worktreesDir, '.broker')), true);
  });
});

test('a sidecar that dies right after passing the probe fails the run (a port taken in the shared namespace)', async () => {
  await withWorktreesDir(async worktreesDir => {
    const { deps, runtime } = makeDeps();
    const slug = slugify('Fix the flaky test');
    runtime.crashed.add(`e-demo-${slug}-1-broker`);
    const result = await runSpawn(
      deps,
      makeParams({
        worktreesDir,
        broker: brokerPlan,
        readiness: fastReadiness,
        runOptions: { rm: true, netns: 'e-egress' },
      })
    );
    assert.equal(result.ran, false);
    assert.match(
      result.error ?? '',
      /Sidecar "runtime-broker" exited right after starting/
    );
    assert.equal(runtime.ran, false);
    // Teardown still removes what was started.
    assert.deepEqual(runtime.removedContainers, [`e-demo-${slug}-1-broker`]);
  });
});

test('an MCP sidecar that never becomes ready is reported by its alias', async () => {
  const { deps, runtime } = makeDeps();
  runtime.tcpScript['everything'] = [false];
  const result = await runSpawn(
    deps,
    makeParams({ sidecars: [sidecar], readiness: fastReadiness })
  );
  assert.equal(result.ran, false);
  assert.match(result.error ?? '', /Sidecar "everything" did not become ready/);
});

// A sibling run (ADR-0013) branches from its parent's worktree, not the host's
// HEAD: the host checkpoints the parent's uncommitted work first, so the
// sibling starts from exactly what the parent sees (ticket 04).
const parent = {
  worktreePath: '/wt/e-demo-parent-1',
  branch: 'e/demo/parent-1',
  artifacts: ['node_modules'],
};

test('a sibling checkpoints a dirty parent worktree, then branches from that commit', async () => {
  const { deps, git, runtime } = makeDeps({
    git: new InMemoryGit({ dirty: true }),
  });
  const result = await runSpawn(deps, makeParams({ parent, role: 'child' }));

  const slug = slugify('Fix the flaky test');
  // The checkpoint is the parent's, with a message naming both runs ...
  assert.deepEqual(git.commits[0], {
    path: parent.worktreePath,
    message: `e: checkpoint e/demo/parent-1 before spawning ${slug}`,
  });
  // ... and it lands before the sibling's worktree is cut from it.
  assert.ok(git.calls.indexOf('commitAll') < git.calls.indexOf('addWorktree'));
  assert.equal(git.worktrees[0].base, 'commit-1');
  assert.equal(result.base, 'commit-1');
  // The sibling's container runs against the sibling's worktree, as always.
  assert.equal(runtime.options?.volumes?.[0].host, git.worktrees[0].path);
});

test('a clean parent is not committed; the sibling branches from its current tip', async () => {
  const { deps, git } = makeDeps({
    git: new InMemoryGit({
      dirty: false,
      worktreeHeads: { [parent.worktreePath]: 'parent-tip' },
    }),
  });
  const result = await runSpawn(deps, makeParams({ parent, role: 'child' }));
  assert.ok(!git.calls.includes('commitAll'));
  assert.equal(git.worktrees[0].base, 'parent-tip');
  assert.equal(result.base, 'parent-tip');
});

test('a checkpoint that cannot be committed fails the request before anything of the sibling exists', async () => {
  const { deps, git, runtime } = makeDeps({
    git: new InMemoryGit({
      dirty: true,
      fail: { commitAll: 'pre-commit hook failed' },
    }),
  });
  await assert.rejects(
    runSpawn(deps, makeParams({ parent, role: 'child' })),
    /Could not checkpoint e\/demo\/parent-1 before spawning .*: pre-commit hook failed/
  );
  assert.equal(git.worktrees.length, 0);
  assert.equal(runtime.ran, false);
});

test('a checkpoint refuses while a merge-back is in progress in the parent worktree (committing would conclude it, markers and all)', async () => {
  const git = new InMemoryGit({ dirty: true, merging: true });
  const { deps } = makeDeps({ git });
  await assert.rejects(
    runSpawn(deps, makeParams({ parent })),
    /Could not checkpoint e\/demo\/parent-1 before spawning .*: a merge-back is in progress in the parent worktree; resolve its conflict and signal --merge first/
  );
  assert.equal(git.commits.length, 0);
  assert.equal(git.worktrees.length, 0);
});

test('without a parent the run branches from the host HEAD and reports it as base', async () => {
  const { deps, git } = makeDeps();
  const result = await runSpawn(deps, makeParams());
  assert.equal(git.worktrees[0].base, 'basesha');
  assert.equal(result.base, 'basesha');
});

// Artifact sync (ticket 05): the parent's gitignored build artifacts reach the
// sibling's container as bind mounts from a scratch dir, never its worktree.
function withParentWorktree<T>(
  fn: (parentWorktree: string, worktreesDir: string) => Promise<T>
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-run-artifacts-'));
  const parentWorktree = path.join(root, 'parent');
  fs.mkdirSync(parentWorktree);
  seedParentArtifacts(parentWorktree);
  const worktreesDir = path.join(root, 'wt');
  return fn(parentWorktree, worktreesDir).finally(() =>
    fs.rmSync(root, { recursive: true, force: true })
  );
}

test("a sibling's container mounts the parent's node_modules from a scratch copy, right after the worktree", async () => {
  await withParentWorktree(async (parentWorktree, worktreesDir) => {
    const { deps, git, runtime } = makeDeps();
    await runSpawn(
      deps,
      makeParams({
        worktreesDir,
        role: 'child',
        keepWorktree: true,
        parent: {
          worktreePath: parentWorktree,
          branch: 'e/demo/parent-1',
          artifacts: ['node_modules'],
        },
      })
    );
    const slug = slugify('Fix the flaky test');
    const copy = path.join(
      worktreesDir,
      '.artifacts',
      `e-demo-${slug}-1`,
      'node_modules'
    );
    assert.deepEqual(runtime.options?.volumes, [
      { host: git.worktrees[0].path, container: '/workspace' },
      { host: copy, container: '/workspace/node_modules' },
    ]);
    assert.equal(
      fs.readFileSync(path.join(copy, 'pkg', 'index.js'), 'utf8'),
      'module.exports = 1;\n'
    );
  });
});

test('the artifact copy goes with the run; .env is never synced even when listed', async () => {
  await withParentWorktree(async (parentWorktree, worktreesDir) => {
    const { deps, runtime } = makeDeps();
    await runSpawn(
      deps,
      makeParams({
        worktreesDir,
        role: 'child',
        parent: {
          worktreePath: parentWorktree,
          branch: 'e/demo/parent-1',
          artifacts: ['.env', 'node_modules'],
        },
      })
    );
    assert.deepEqual(
      runtime.options?.volumes?.map(v => v.container),
      ['/workspace', '/workspace/node_modules']
    );
    assert.equal(fs.existsSync(path.join(worktreesDir, '.artifacts')), true);
    assert.equal(
      fs.readdirSync(path.join(worktreesDir, '.artifacts')).length,
      0,
      'the run scratch copy is removed at teardown'
    );
  });
});

test('an empty allowlist syncs nothing', async () => {
  await withParentWorktree(async (parentWorktree, worktreesDir) => {
    const { deps, runtime } = makeDeps();
    await runSpawn(
      deps,
      makeParams({
        worktreesDir,
        role: 'child',
        parent: {
          worktreePath: parentWorktree,
          branch: 'e/demo/parent-1',
          artifacts: [],
        },
      })
    );
    assert.deepEqual(
      runtime.options?.volumes?.map(v => v.container),
      ['/workspace']
    );
  });
});

// Sibling requests (ticket 06): while the agent runs, the host picks requests
// up from the broker's spool and launches each as a child `e spawn`; the
// sibling process reports its own status. Here the launcher is scripted and
// the fake runtime plays the agent posting a request mid-run.
// The shared `makeSleep` spy yields on its own now, so these tests need no
// local workaround; this stays only because they want a real timer tick
// rather than a microtask boundary between polls.
const yielding = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 2)));

test('a run with a broker launches sibling requests as child spawns while its agent runs', async () => {
  await withWorktreesDir(async worktreesDir => {
    const { deps, git, runtime } = makeDeps();
    const slug = slugify('Fix the flaky test');
    const runName = `e-demo-${slug}-1`;
    const spool = path.join(worktreesDir, '.broker', runName);
    const launches: ChildLaunch[] = [];
    const launch: ChildLauncher = l => {
      launches.push(l);
      // The sibling process reports for itself, as a real `e spawn` does.
      writeStatus(spool, l.request.id, {
        status: 'running',
        branch: 'e/researcher/look-into-x-1',
        updatedAt: 't',
      });
      writeStatus(spool, l.request.id, {
        status: 'done',
        branch: 'e/researcher/look-into-x-1',
        exitCode: 0,
        updatedAt: 't',
      });
      return { exited: Promise.resolve(0), kill: () => {} };
    };
    runtime.onRun = async () => {
      // The broker spools the agent's request; the agent keeps working a bit.
      writeRequest(spool, {
        id: 'sib-001',
        agent: 'researcher',
        prompt: 'look into X',
        requestedAt: 't',
      });
      while (launches.length === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    };

    const result = await runSpawn(
      { ...deps, sleep: yielding },
      makeParams({
        worktreesDir,
        broker: brokerPlan,
        readiness: fastReadiness,
        keepWorktree: true,
        maxSiblings: 2,
        siblingHost: {
          launch,
          readiness: { attempts: 600, intervalMs: 1 },
          passthroughArgs: ['--dir', '/store'],
          passthroughEnv: { [Env.RUNTIME_VAR]: 'podman' },
        },
      })
    );
    assert.equal(result.ran, true);
    assert.equal(launches.length, 1);
    const [l] = launches;
    assert.equal(l.request.agent, 'researcher');
    assert.deepEqual(l.args, [
      'spawn',
      'researcher',
      '--dir',
      '/store',
      '--',
      'look into X',
    ]);
    assert.equal(l.env[Env.SPAWN_ROLE_VAR], 'child');
    assert.equal(l.env[Env.SPAWN_PARENT_WORKTREE_VAR], git.worktrees[0].path);
    assert.equal(l.env[Env.SPAWN_PARENT_BRANCH_VAR], `e/demo/${slug}-1`);
    assert.equal(l.env[Env.SPAWN_PARENT_NETWORK_VAR], `${runName}-net`);
    assert.equal(l.env[Env.SPAWN_SPOOL_VAR], spool);
    assert.equal(l.env[Env.SPAWN_SIBLING_ID_VAR], 'sib-001');
    assert.equal(l.env[Env.RUNTIME_VAR], 'podman');
    assert.equal(l.logFile, path.join(spool, 'logs', 'sib-001.log'));
    assert.equal(readStatus(spool, 'sib-001')?.status, 'done');
    // run.json carries the fan-out bound for the broker's own synchronous check.
    assert.equal(readRunInfo(spool)?.maxSiblings, 2);

    // Merge-back (ticket 07): the sibling's branch was folded into the
    // parent's worktree and the result rides back on the run.
    assert.deepEqual(git.merges, [
      {
        worktreePath: git.worktrees[0].path,
        branch: 'e/researcher/look-into-x-1',
        message: 'e: merge back e/researcher/look-into-x-1',
      },
    ]);
    assert.deepEqual(result.siblings, [
      {
        id: 'sib-001',
        agent: 'researcher',
        branch: 'e/researcher/look-into-x-1',
        status: 'done',
        exitCode: 0,
        merge: { status: 'merged' },
        report: 'e-runs/sib-001/report.md',
      },
    ]);
    // The status the agent polls carries the merge, and the report is in the
    // parent's own worktree.
    assert.deepEqual(readStatus(spool, 'sib-001')?.merge, { status: 'merged' });
    const report = path.join(
      git.worktrees[0].path,
      'e-runs',
      'sib-001',
      'report.md'
    );
    assert.match(fs.readFileSync(report, 'utf8'), /^# Sibling sib-001: merged/);
  });
});

test('a merge held until the run ends is retried after the output commit and before the push', async () => {
  await withWorktreesDir(async worktreesDir => {
    const { deps, git, runtime } = makeDeps({
      git: new InMemoryGit({
        // Held over files in flight on exit; clean when retried at the end.
        merge: {
          'e/researcher/look-1': { status: 'refused', files: ['src/a.ts'] },
        },
      }),
    });
    const slug = slugify('Fix the flaky test');
    const spool = path.join(worktreesDir, '.broker', `e-demo-${slug}-1`);
    const launch: ChildLauncher = l => {
      writeStatus(spool, l.request.id, {
        status: 'done',
        branch: 'e/researcher/look-1',
        exitCode: 0,
        updatedAt: 't',
      });
      // The parent still writes while the sibling is merged: the first
      // attempt is refused; a report lands in the worktree either way.
      git.setDirty(true);
      return { exited: Promise.resolve(0), kill: () => {} };
    };
    runtime.onRun = async () => {
      writeRequest(spool, {
        id: 'sib-001',
        agent: 'researcher',
        prompt: 'look',
        requestedAt: 't',
      });
      // The agent sees the merge held, finishes its edits and exits without
      // signalling: the run's end is the retry that lands it.
      while (readStatus(spool, 'sib-001')?.merge?.status !== 'held') {
        await new Promise(resolve => setImmediate(resolve));
      }
      git.setMerge('e/researcher/look-1', { status: 'merged' });
    };
    const result = await runSpawn(
      { ...deps, sleep: yielding },
      makeParams({
        worktreesDir,
        broker: brokerPlan,
        readiness: fastReadiness,
        keepWorktree: true,
        siblingHost: { launch, readiness: { attempts: 600, intervalMs: 1 } },
      })
    );
    assert.equal(result.siblings?.[0].merge.status, 'merged');
    // Order: the checkpoint before the first (refused) merge; at the run's
    // end the retry's merge, then the push (the fake's tree reads clean, so
    // no output or reports commit here - the real-git e2e covers those).
    assert.deepEqual(
      git.commits.map(c => c.message),
      [
        'e: checkpoint e/demo/fix-flaky-test-1 before merging e/researcher/look-1',
      ]
    );
    assert.deepEqual(
      git.calls.filter(c => ['merge', 'commitAll', 'push'].includes(c)),
      ['commitAll', 'merge', 'merge', 'push']
    );
    assert.equal(git.pushed.length, 1);
  });
});

test('a request still waiting when the agent exits is failed: nobody is left to receive its work', async () => {
  await withWorktreesDir(async worktreesDir => {
    const { deps, runtime } = makeDeps();
    const slug = slugify('Fix the flaky test');
    const spool = path.join(worktreesDir, '.broker', `e-demo-${slug}-1`);
    const launches: ChildLaunch[] = [];
    runtime.onRun = () => {
      // Posted in the agent's last moment: the consumer is asleep until stop.
      writeRequest(spool, {
        id: 'sib-001',
        agent: 'a',
        prompt: 'late',
        requestedAt: 't',
      });
    };
    await runSpawn(
      { ...deps, sleep: () => new Promise(resolve => setTimeout(resolve, 30)) },
      makeParams({
        worktreesDir,
        broker: brokerPlan,
        readiness: fastReadiness,
        keepWorktree: true,
        siblingHost: {
          launch: l => (
            launches.push(l),
            { exited: Promise.resolve(0), kill: () => {} }
          ),
        },
      })
    );
    assert.equal(launches.length, 0);
    assert.match(
      readStatus(spool, 'sib-001')?.error ?? '',
      /parent run ended before the request was picked up/
    );
  });
});

test('a sibling reports running with its branch, then done, into its parent spool; it neither pushes nor opens a PR', async () => {
  await withWorktreesDir(async worktreesDir => {
    const spool = path.join(worktreesDir, 'spool');
    ensureSpool(spool);
    const pullRequest = new FakePullRequest();
    const { deps, git, runtime } = makeDeps({ pullRequest });
    let seenWhileRunning: string | undefined;
    runtime.onRun = () => {
      seenWhileRunning = readStatus(spool, 'sib-001')?.status;
    };
    const result = await runSpawn(
      deps,
      makeParams({
        worktreesDir,
        role: 'child',
        gitPlatform: 'github',
        parent,
        sibling: { spoolDir: spool, id: 'sib-001' },
      })
    );
    assert.equal(seenWhileRunning, 'running');
    const status = readStatus(spool, 'sib-001');
    assert.equal(status?.status, 'done');
    assert.equal(status?.branch, result.branch);
    assert.equal(status?.exitCode, 0);
    // Delivery is the merge back into the parent, not a push or PR.
    assert.ok(!git.calls.includes('push'));
    assert.deepEqual(pullRequest.specs, []);
    assert.equal(result.pushed, false);
  });
});

test('a sibling that fails before its container reports failed with the reason', async () => {
  await withWorktreesDir(async worktreesDir => {
    const spool = path.join(worktreesDir, 'spool');
    ensureSpool(spool);
    const { deps } = makeDeps({
      git: new InMemoryGit({ dirty: true, fail: { commitAll: 'hook failed' } }),
    });
    await assert.rejects(
      runSpawn(
        deps,
        makeParams({
          worktreesDir,
          role: 'child',
          parent,
          sibling: { spoolDir: spool, id: 'sib-002' },
        })
      ),
      /Could not checkpoint/
    );
    const status = readStatus(spool, 'sib-002');
    assert.equal(status?.status, 'failed');
    assert.match(status?.error ?? '', /Could not checkpoint e\/demo\/parent-1/);
  });
});

test('a run with a broker refuses to start without an explicit sibling launcher', async () => {
  const { deps, runtime } = makeDeps();
  await assert.rejects(
    runSpawn(deps, makeParams({ broker: brokerPlan, siblingHost: undefined })),
    /needs siblingHost\.launch/
  );
  assert.equal(runtime.ran, false);
  assert.deepEqual(runtime.startedSidecars, []);
});

// Cancel (ADR-0015): `abort` is the run's SIGTERM. Before the container it
// ends the run without one; during it the container is removed and the
// normal (non-zero) teardown follows.

test('abort before the container: no run, no commit, exit code 143, worktree removed', async () => {
  const { deps, git, runtime } = makeDeps();
  const controller = new AbortController();
  controller.abort();
  const result = await runSpawn(deps, makeParams({ abort: controller.signal }));
  assert.equal(result.ran, false);
  assert.equal(result.exitCode, 143);
  assert.match(result.error ?? '', /canceled before the container started/);
  assert.equal(runtime.ran, false);
  assert.equal(git.commits.length, 0);
  assert.equal(git.removedWorktrees.length, 1);
});

test('abort while the container runs: the container is removed by name, nothing is committed or pushed, the exit code is non-zero', async () => {
  const runtime = new FakeRuntime(0);
  const controller = new AbortController();
  runtime.onRun = () => {
    controller.abort();
  };
  const { deps, git } = makeDeps({ runtime });
  git.setDirty(true);
  const result = await runSpawn(deps, makeParams({ abort: controller.signal }));
  assert.equal(result.ran, true);
  assert.deepEqual(runtime.removedContainers, ['e-demo-fix-flaky-test-1']);
  // The fake "container" still returned 0; a canceled run never counts as a success.
  assert.equal(result.exitCode, 143);
  assert.equal(git.commits.length, 0);
  assert.deepEqual(git.pushed, []);
});

test('the report markers (an A2A task): status goes into the spool with the branch, then done with pushed and the PR/MR URL; the run still pushes', async () => {
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), 'e-report-spool-'));
  try {
    ensureSpool(spool);
    writeRequest(spool, {
      id: 'a2a-001',
      agent: 'demo',
      prompt: 'Fix the flaky test',
      requestedAt: 't',
    });
    const pr = new FakePullRequest({ url: 'https://example.com/pr/1' });
    const runtime = new FakeRuntime(0);
    runtime.onRun = () => {
      const running = readStatus(spool, 'a2a-001');
      assert.equal(running?.status, 'running');
      assert.equal(running?.branch, 'e/demo/fix-flaky-test-1');
    };
    const { deps, git } = makeDeps({ runtime, pullRequest: pr });
    git.setDirty(true);
    const result = await runSpawn(
      deps,
      makeParams({
        report: { spoolDir: spool, id: 'a2a-001' },
        gitPlatform: 'github',
      })
    );
    assert.equal(result.pushed, true);
    const done = readStatus(spool, 'a2a-001');
    assert.equal(done?.status, 'done');
    assert.equal(done?.exitCode, 0);
    assert.equal(done?.pushed, true);
    assert.equal(done?.pullRequestUrl, 'https://example.com/pr/1');
    assert.equal(readRecord(spool, 'a2a-001')?.taskState, 'completed');
  } finally {
    fs.rmSync(spool, { recursive: true, force: true });
  }
});

test('runSpawn: the verify check runs in a second container, against work the run has already committed', async () => {
  const { deps, git, runtime } = makeDeps();
  git.setDirty(true);
  // The worktree is mounted first in both containers, so this reads the same
  // tree the check sees.
  const dirtyWhenEachContainerRan: boolean[] = [];
  runtime.onRun = options => {
    dirtyWhenEachContainerRan.push(git.isDirty(options.volumes![0].host));
  };
  await runSpawn(deps, makeParams({ verify: { command: 'npm test' } }));
  assert.equal(runtime.runs.length, 2, 'the agent, then the check');
  assert.deepEqual(dirtyWhenEachContainerRan, [true, false]);
  assert.deepEqual(runtime.runs[1].command, ['sh', '-c', 'npm test']);
});

test('runSpawn: a Store with no verify declaration starts no second container', async () => {
  const { deps, git, runtime } = makeDeps();
  git.setDirty(true);
  await runSpawn(deps, makeParams());
  assert.equal(runtime.runs.length, 1);
});

test('runSpawn: the check installing its dependencies does not strand the worktree', async () => {
  const { deps, git, runtime } = makeDeps();
  git.setDirty(true);
  let worktree = '';
  runtime.onRun = options => {
    worktree = options.volumes![0].host;
    // Both containers dirty the tree: the agent with its work, the check with
    // the `node_modules` it installs for itself.
    git.setDirty(true, worktree);
  };
  await runSpawn(
    deps,
    makeParams({ verify: { command: 'npm ci && npm test' } })
  );
  assert.deepEqual(
    git.removedWorktrees,
    [worktree],
    'what the check left behind is the checks own, not uncommitted run work'
  );
});

test('runSpawn: a green verdict opens the PR and the run exits 0', async () => {
  const pullRequest = new FakePullRequest();
  const { deps, git, runtime } = makeDeps({ pullRequest });
  git.setDirty(true);
  const result = await runSpawn(
    deps,
    makeParams({ gitPlatform: 'github', verify: { command: 'npm test' } })
  );
  assert.deepEqual(result.verify, {
    verdict: 'green',
    exitCode: 0,
    output: '',
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.pushed, true);
  assert.equal(pullRequest.specs.length, 1);
  assert.equal(runtime.runs.length, 2);
});

test('runSpawn: a red verdict pushes the attempt, opens no PR, and exits non-zero', async () => {
  const pullRequest = new FakePullRequest();
  const { deps, git, runtime } = makeDeps({ pullRequest });
  git.setDirty(true);
  runtime.exitCodes = [0, 1];
  const result = await runSpawn(
    deps,
    // One attempt, so this pins the verdict's own consequences rather than
    // the loop's - the loop has its own tests below.
    makeParams({
      gitPlatform: 'github',
      verify: { command: 'npm test' },
      loop: { ...DEFAULT_LOOP_CAPS, maxIterations: 1 },
    })
  );
  assert.deepEqual(result.verify, {
    verdict: 'red',
    exitCode: 1,
    reason: 'exit',
    output: '',
  });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.captured, true, 'the attempt is committed');
  assert.equal(result.pushed, true, 'and pushed, so a human can read it');
  assert.deepEqual(pullRequest.specs, [], 'nothing claims it was accepted');
});

test('runSpawn: a broken check aborts the same way - pushed, no PR, non-zero', async () => {
  const pullRequest = new FakePullRequest();
  const { deps, git, runtime } = makeDeps({ pullRequest });
  git.setDirty(true);
  runtime.exitCodes = [0, 127];
  const result = await runSpawn(
    deps,
    makeParams({ gitPlatform: 'github', verify: { command: 'npm test' } })
  );
  assert.equal(result.verify?.verdict, 'broken');
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.pushed, true);
  assert.deepEqual(pullRequest.specs, []);
});

test('runSpawn: a harness that died is never gated - there is nothing committed to check', async () => {
  const { deps, git, runtime } = makeDeps();
  git.setDirty(true);
  runtime.exitCodes = [137];
  const result = await runSpawn(
    deps,
    makeParams({ verify: { command: 'npm test' } })
  );
  assert.equal(runtime.runs.length, 1);
  assert.equal(result.verify, undefined);
  // For a gated run the exit code is the run's verdict; the harness's own
  // code survives in the iteration entry.
  assert.equal(result.exitCode, 1);
  assert.equal(result.iterations?.[0].harnessExitCode, 137);
});

test('runSpawn: an interactive run is not gated - its human is the gate', async () => {
  const { deps, git, runtime } = makeDeps();
  git.setDirty(true);
  await runSpawn(
    deps,
    makeParams({ interactive: true, verify: { command: 'npm test' } })
  );
  assert.equal(runtime.runs.length, 1);
});

test('runSpawn: a sibling is not gated - it opens no PR, and the parent gate covers the merged whole', async () => {
  await withWorktreesDir(async worktreesDir => {
    const spool = path.join(worktreesDir, 'spool');
    ensureSpool(spool);
    const { deps, git, runtime } = makeDeps();
    git.setDirty(true);
    await runSpawn(
      deps,
      makeParams({
        worktreesDir,
        role: 'child',
        verify: { command: 'npm test' },
        sibling: { spoolDir: spool, id: 'sib-001' },
      })
    );
    assert.equal(runtime.runs.length, 1);
  });
});

/*
 * The loop (ADR-0016). `exitCodes` scripts the containers in order - agent,
 * check, agent, check - and `onRun` plays the agent dirtying the worktree, so
 * each attempt has something to commit.
 */
function gatedRun(runtime: FakeRuntime, git: InMemoryGit) {
  git.setDirty(true);
  runtime.onRun = options => {
    if (options.name?.endsWith('-verify')) return;
    git.setDirty(true, options.volumes![0].host);
  };
}

test('runSpawn: a red verdict starts another container carrying the check output as feedback', async () => {
  const { deps, git, runtime } = makeDeps();
  gatedRun(runtime, git);
  runtime.exitCodes = [0, 1, 0, 0];
  runtime.outputs = ['FAIL src/auth.test.ts', ''];
  const result = await runSpawn(
    deps,
    makeParams({ verify: { command: 'npm test' } })
  );
  assert.equal(runtime.runs.length, 4, 'agent, check, agent, check');
  const secondPrompt = runtime.runs[2].command.join(' ');
  assert.match(
    secondPrompt,
    /Fix the flaky test/,
    'the task is restated whole'
  );
  assert.match(secondPrompt, /attempt 1/);
  assert.match(secondPrompt, /FAIL src\/auth\.test\.ts/);
  assert.equal(result.verify?.verdict, 'green');
  assert.equal(result.exitCode, 0);
});

test('runSpawn: every attempt leaves a commit, so exhaustion never loses the last one', async () => {
  const { deps, git, runtime } = makeDeps();
  gatedRun(runtime, git);
  runtime.exitCodes = [0, 1, 0, 1, 0, 1];
  const result = await runSpawn(
    deps,
    makeParams({
      verify: { command: 'npm test' },
      loop: { ...DEFAULT_LOOP_CAPS, maxIterations: 3 },
    })
  );
  assert.equal(runtime.runs.length, 6, 'three attempts, each with its check');
  assert.equal(git.commits.length, 3);
  assert.equal(result.outcome, 'exhausted');
  assert.equal(result.pushed, true, 'the attempts survive for a human to read');
  assert.notEqual(result.exitCode, 0);
});

test('runSpawn: the loop reports one entry per attempt', async () => {
  const { deps, git, runtime } = makeDeps();
  gatedRun(runtime, git);
  runtime.exitCodes = [0, 1, 0, 0];
  const result = await runSpawn(
    deps,
    makeParams({ verify: { command: 'npm test' } })
  );
  assert.equal(result.iterations?.length, 2);
  assert.equal(result.iterations?.[0].attempt, 1);
  assert.equal(result.iterations?.[0].verdict, 'red');
  assert.equal(result.iterations?.[1].verdict, 'green');
  assert.ok(result.iterations?.[0].commit, 'each attempt names its commit');
  assert.equal(result.outcome, 'verified');
});

test('runSpawn: a harness that dies mid-loop aborts, and that attempt commits nothing', async () => {
  const { deps, git, runtime } = makeDeps();
  gatedRun(runtime, git);
  runtime.exitCodes = [0, 1, 137];
  const result = await runSpawn(
    deps,
    makeParams({ verify: { command: 'npm test' } })
  );
  assert.equal(runtime.runs.length, 3, 'no check runs for a dead container');
  assert.equal(git.commits.length, 1, 'only the attempt that finished');
  assert.equal(result.outcome, 'aborted');
  assert.notEqual(result.exitCode, 0);
});

test('runSpawn: a broken check aborts the loop instead of spending the budget on it', async () => {
  const { deps, git, runtime } = makeDeps();
  gatedRun(runtime, git);
  runtime.exitCodes = [0, 127, 0, 0];
  const result = await runSpawn(
    deps,
    makeParams({ verify: { command: 'npm test' } })
  );
  assert.equal(runtime.runs.length, 2);
  assert.equal(result.outcome, 'aborted');
});

test('runSpawn: a run with no gate reports no iterations at all', async () => {
  const { deps, git, runtime } = makeDeps();
  gatedRun(runtime, git);
  const result = await runSpawn(deps, makeParams());
  assert.equal(result.iterations, undefined);
  assert.equal(result.outcome, undefined);
  assert.equal(runtime.runs.length, 1);
});

test('runSpawn: the launch prompt names the check and warns it runs elsewhere', async () => {
  const { deps, git, runtime } = makeDeps();
  gatedRun(runtime, git);
  const prompt = (
    await (async () => {
      await runSpawn(deps, makeParams({ verify: { command: 'npm test' } }));
      return runtime.runs[0].command.join(' ');
    })()
  ).toString();
  assert.match(
    prompt,
    /npm test/,
    'the acceptance criterion is stated up front'
  );
  assert.match(prompt, /separate container/i);
  // Telling an agent nobody is watching reads as "be careful" to one and as
  // "nobody is checking" to another, and the exit code cannot tell us which.
  assert.doesNotMatch(prompt, /no human|nobody is watching|unattended/i);
});

test('runSpawn: the container limits reach the agent and the check alike', async () => {
  const { deps, git, runtime } = makeDeps();
  gatedRun(runtime, git);
  await runSpawn(
    deps,
    makeParams({
      verify: { command: 'npm test' },
      runOptions: { rm: true, memory: '4g', cpus: 2, pidsLimit: 2048 },
    })
  );
  for (const [which, r] of [
    ['agent', runtime.runs[0]],
    ['check', runtime.runs[1]],
  ] as const) {
    assert.equal(r.options.memory, '4g', which);
    assert.equal(r.options.cpus, 2, which);
    assert.equal(r.options.pidsLimit, 2048, which);
  }
});

test('runSpawn: exhaustion exits 2 and says which budget ran out', async () => {
  const { deps, git, runtime } = makeDeps();
  gatedRun(runtime, git);
  runtime.exitCodes = [0, 1, 0, 1];
  const result = await runSpawn(
    deps,
    makeParams({
      verify: { command: 'npm test' },
      loop: { ...DEFAULT_LOOP_CAPS, maxIterations: 2 },
    })
  );
  assert.equal(result.outcome, 'exhausted');
  assert.equal(result.reason, 'exhausted:iterations');
  // A caller plausibly branches on this: "out of budget, maybe re-queue with
  // more" is a different reaction from "it broke".
  assert.equal(result.exitCode, 2);
});

test('runSpawn: a broken check is aborted and exits 1', async () => {
  const { deps, git, runtime } = makeDeps();
  gatedRun(runtime, git);
  runtime.exitCodes = [0, 127];
  const result = await runSpawn(
    deps,
    makeParams({ verify: { command: 'npm test' } })
  );
  assert.equal(result.reason, 'aborted:verify-broken');
  assert.equal(result.exitCode, 1);
});

test('runSpawn: a 137 nobody asked for is an OOM, not a timeout', async () => {
  const { deps, git, runtime } = makeDeps();
  gatedRun(runtime, git);
  runtime.exitCodes = [137];
  const result = await runSpawn(
    deps,
    makeParams({ verify: { command: 'npm test' } })
  );
  // Our own kill and an OOM both end the container on 137; they are separable
  // only host-side, by whether a timer of ours fired.
  assert.equal(result.reason, 'aborted:oom');
  assert.equal(result.exitCode, 1);
});

test('runSpawn: any other harness death is named as such', async () => {
  const { deps, git, runtime } = makeDeps();
  gatedRun(runtime, git);
  runtime.exitCodes = [1];
  const result = await runSpawn(
    deps,
    makeParams({ verify: { command: 'npm test' } })
  );
  assert.equal(result.reason, 'aborted:harness-exit');
});

/*
 * A container that hangs until the host pulls the plug - which is what a kill
 * does in production, and the only way a wall clock is observable in a fake.
 */
function hangingAgent(runtime: FakeRuntime, git: InMemoryGit) {
  let release: (() => void) | undefined;
  runtime.onRun = options => {
    if (options.name?.endsWith('-verify')) return;
    git.setDirty(true, options.volumes![0].host);
    return new Promise<void>(resolve => {
      release = resolve;
    });
  };
  const remove = runtime.removeContainer.bind(runtime);
  runtime.removeContainer = (name: string) => {
    remove(name);
    release?.();
  };
}

test(
  'runSpawn: an attempt past its wall clock is killed, and its partial work is kept',
  { timeout: 5000 },
  async () => {
    const { deps, git, runtime } = makeDeps({ runtime: new FakeRuntime(137) });
    hangingAgent(runtime, git);
    const result = await runSpawn(
      deps,
      makeParams({
        verify: { command: 'npm test' },
        loop: { ...DEFAULT_LOOP_CAPS, iterationTimeoutMs: 20 },
      })
    );
    assert.deepEqual(runtime.removedContainers, ['e-demo-fix-flaky-test-1']);
    assert.equal(result.outcome, 'exhausted');
    assert.equal(result.reason, 'exhausted:iteration-timeout');
    assert.equal(result.exitCode, 2);
    // The host chose the moment, so the worktree holds what the agent had at
    // the limit - not what survived an unknown fault. Losing it would repeat
    // the mistake the commit-every-attempt rule exists to avoid.
    assert.deepEqual(
      git.commits.map(c => c.message),
      [`e: timed-out attempt 1 for ${result.branch}`]
    );
    assert.equal(result.pushed, true);
  }
);

test(
  'runSpawn: the total wall clock fires mid-attempt, not at the boundary',
  { timeout: 5000 },
  async () => {
    const { deps, git, runtime } = makeDeps({ runtime: new FakeRuntime(137) });
    hangingAgent(runtime, git);
    const result = await runSpawn(
      deps,
      makeParams({
        verify: { command: 'npm test' },
        // A boundary-only check would let an attempt that started in budget run
        // its full length past the total, so the configured number would be a
        // lower bound with an unknown surcharge.
        loop: {
          ...DEFAULT_LOOP_CAPS,
          totalTimeoutMs: 20,
          iterationTimeoutMs: 600_000,
        },
      })
    );
    assert.equal(result.reason, 'exhausted:total-timeout');
    assert.equal(result.exitCode, 2);
  }
);

test(
  'runSpawn: an ungated run is bounded too - a hung container is the same problem',
  { timeout: 5000 },
  async () => {
    const { deps, git, runtime } = makeDeps({ runtime: new FakeRuntime(137) });
    hangingAgent(runtime, git);
    const result = await runSpawn(
      deps,
      makeParams({ loop: { ...DEFAULT_LOOP_CAPS, iterationTimeoutMs: 20 } })
    );
    assert.equal(runtime.removedContainers.length, 1);
    assert.equal(git.commits.length, 1, 'its partial work is kept as well');
    // Outside a loop the exit code stays the harness's: nothing about this run
    // is a verdict.
    assert.equal(result.exitCode, 137);
    assert.equal(result.outcome, undefined);
  }
);

test(
  'runSpawn: an interactive session is never killed at the wall clock',
  { timeout: 5000 },
  async () => {
    const { deps, runtime } = makeDeps();
    let release: (() => void) | undefined;
    runtime.onRun = () =>
      new Promise<void>(resolve => {
        release = resolve;
      });
    const pending = runSpawn(
      deps,
      makeParams({
        interactive: true,
        loop: { ...DEFAULT_LOOP_CAPS, iterationTimeoutMs: 20 },
      })
    );
    await new Promise(r => setTimeout(r, 120));
    assert.deepEqual(
      runtime.removedContainers,
      [],
      'killing a human mid-session would be hostile'
    );
    release?.();
    await pending;
  }
);

test('runSpawn: the soft mark warns the human and never the agent', async () => {
  const { deps, git, runtime } = makeDeps();
  gatedRun(runtime, git);
  const dirty = runtime.onRun!;
  // The first attempt has to take measurable time, or "past the soft mark"
  // depends on whether a millisecond happened to tick.
  runtime.onRun = async options => {
    await dirty(options);
    await new Promise(r => setTimeout(r, 10));
  };
  runtime.exitCodes = [0, 1, 0, 0];
  const result = await runSpawn(
    deps,
    makeParams({
      verify: { command: 'npm test' },
      loop: { ...DEFAULT_LOOP_CAPS, softTotalTimeoutMs: 1 },
    })
  );
  assert.match(result.softTimeoutWarning ?? '', /soft time limit/i);
  // Same reason the countdown is withheld: a deadline in the prompt buys
  // `.skip` and `|| true`.
  assert.doesNotMatch(runtime.runs[2].command.join(' '), /time limit/i);
});
