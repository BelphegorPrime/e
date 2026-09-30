import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryGit } from '../../ports/git/memory.js';
import type { PullRequest, PullRequestSpec } from '../../ports/github/index.js';
import type { Harness } from '../../core/harness/index.js';
import {
  runSpawn,
  launchPrompt,
  resumePrompt,
  RESUME_DEFAULT_PROMPT,
  type RunSpawnDeps,
  type RunSpawnParams,
} from './runSpawn.js';
import {
  FakeRuntime,
  demoAgent,
  demoHarness,
  makeSleep,
} from './runSpawn.testSupport.js';
import {
  openRunSession,
  readRunSession,
  runSessionDirFor,
  type RunSessionInit,
} from './runSession.js';
import { fromBranch, type RunName } from '../../core/identity/runName.js';
import { DEFAULT_LOOP_CAPS } from '../../core/store/config.js';
import type { ChildLauncher } from './childRun.js';

// ADR-0017: a Run of a harness that can resume keeps its session on the host,
// and `resume` continues it on the Run's own branch.

/** The demo harness with the resume capability: `demo --continue [-p <prompt>]`. */
const resumable: Harness = {
  ...demoHarness,
  sessionDir: '/home/node/.demo/sessions',
  resumeCommand: (prompt, model) => [
    'demo',
    '--continue',
    ...(prompt === undefined ? [] : ['-p', prompt]),
    ...(model ? ['-m', model] : []),
  ],
};

const init: RunSessionInit = {
  agent: 'demo',
  harness: 'demo',
  harnessVersion: '1.0.0',
  mcp: [],
  skills: [],
};

const branch = 'e/demo/fix-the-bug-3';
const run = fromBranch(branch) as RunName;
const recordedBase = { sha: 'origsha', branch: 'dev' };

class FakePullRequest implements PullRequest {
  specs: PullRequestSpec[] = [];
  create(spec: PullRequestSpec): string {
    this.specs.push(spec);
    return `https://example.com/pr/${spec.head}`;
  }
}

const noSiblingsExpected: ChildLauncher = launch => {
  throw new Error(`unexpected sibling launch for ${launch.request.id}`);
};

function makeDeps(git = new InMemoryGit(), runtime = new FakeRuntime()) {
  const deps: RunSpawnDeps = {
    git,
    runtime,
    pullRequest: new FakePullRequest(),
    sleep: makeSleep(runtime),
  };
  return { deps, git, runtime };
}

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-resume-run-'));
  return fn(dir).finally(() =>
    fs.rmSync(dir, { recursive: true, force: true })
  );
}

function makeParams(
  tmp: string,
  overrides: Partial<RunSpawnParams> = {}
): RunSpawnParams {
  return {
    agent: demoAgent,
    harness: resumable,
    prompt: 'Fix the bug',
    imageTag: 'e-harness-demo',
    runOptions: { rm: true },
    worktreesDir: path.join(tmp, 'worktrees'),
    siblingHost: { launch: noSiblingsExpected },
    session: { storeDir: path.join(tmp, '.e'), init },
    ...overrides,
  };
}

/** Resume params for {@link branch}, with a session already on disk. */
function resumeParams(
  tmp: string,
  overrides: Partial<RunSpawnParams> = {}
): RunSpawnParams {
  const storeDir = path.join(tmp, '.e');
  openRunSession(storeDir, run, { init, base: recordedBase });
  return makeParams(tmp, {
    prompt: 'now add a test',
    resume: { branch, base: recordedBase, elapsedMs: 0 },
    ...overrides,
  });
}

test('a Run of a resumable harness mounts its host session dir at the harness sessionDir', () =>
  withTmp(async tmp => {
    const { deps, git, runtime } = makeDeps();
    const result = await runSpawn(deps, makeParams(tmp));
    const ran = fromBranch(result.branch!) as RunName;
    const storeDir = path.join(tmp, '.e');
    assert.deepEqual(runtime.options?.volumes, [
      { host: git.worktrees[0].path, container: '/workspace' },
      {
        host: path.join(runSessionDirFor(storeDir, ran), 'harness'),
        container: '/home/node/.demo/sessions',
      },
    ]);
    const record = readRunSession(storeDir, ran);
    assert.equal(record?.branch, result.branch);
    assert.deepEqual(record?.base, { sha: 'basesha', branch: 'main' });
    // The session is not scratch: it survives the Run's teardown.
    assert.ok(fs.existsSync(runSessionDirFor(storeDir, ran)));
    // A first run starts a session like any other: the plain command.
    assert.deepEqual(runtime.command, [
      'demo',
      '-p',
      launchPrompt('Fix the bug'),
    ]);
  }));

test('the wall clock a non-interactive Run spent is added to its session record', () =>
  withTmp(async tmp => {
    const { deps, runtime } = makeDeps();
    runtime.onRun = () => new Promise(resolve => setTimeout(resolve, 15));
    const result = await runSpawn(deps, makeParams(tmp));
    const record = readRunSession(
      path.join(tmp, '.e'),
      fromBranch(result.branch!) as RunName
    );
    assert.ok(record!.elapsedMs >= 10, `elapsed ${record?.elapsedMs}`);
  }));

test('an interactive Run spends no budget, so it adds no wall clock', () =>
  withTmp(async tmp => {
    const { deps, runtime } = makeDeps();
    runtime.onRun = () => new Promise(resolve => setTimeout(resolve, 15));
    const result = await runSpawn(deps, makeParams(tmp, { interactive: true }));
    const record = readRunSession(
      path.join(tmp, '.e'),
      fromBranch(result.branch!) as RunName
    );
    assert.equal(record?.elapsedMs, 0);
  }));

test('a session that cannot be prepared costs a fresh Run nothing but the session', () =>
  withTmp(async tmp => {
    const { deps, runtime } = makeDeps();
    // `.e` is a file: nothing can be created under it.
    fs.writeFileSync(path.join(tmp, '.e'), 'not a dir');
    const result = await runSpawn(deps, makeParams(tmp));
    assert.equal(result.exitCode, 0);
    assert.equal(runtime.options?.volumes?.length, 1);
  }));

test('resume checks the Run branch out again - no new branch - and continues its session', () =>
  withTmp(async tmp => {
    const { deps, git, runtime } = makeDeps(
      new InMemoryGit({ branches: [branch], dirty: true })
    );
    const params = resumeParams(tmp, { model: 'demo-pro' });
    const result = await runSpawn(deps, params);

    assert.equal(result.branch, branch);
    assert.deepEqual(git.worktrees, [], 'no branch was cut');
    assert.deepEqual(git.checkedOut, [
      { path: path.join(params.worktreesDir, ...branch.split('/')), branch },
    ]);
    assert.equal(runtime.options?.name, run.name);
    assert.deepEqual(runtime.command, [
      'demo',
      '--continue',
      '-p',
      resumePrompt('now add a test'),
      '-m',
      'demo-pro',
    ]);
    // The branch is pushed and the PR targets the base the Run recorded.
    assert.deepEqual(git.pushed, [branch]);
    const pr = (deps.pullRequest as FakePullRequest).specs;
    assert.equal(pr.length, 0, 'no platform configured, no PR');
    assert.equal(result.base, 'origsha');
  }));

test('resume opens its PR into the recorded base branch, not the host HEAD', () =>
  withTmp(async tmp => {
    const { deps } = makeDeps(
      new InMemoryGit({ branches: [branch], dirty: true, currentBranch: 'x' })
    );
    await runSpawn(deps, resumeParams(tmp, { gitPlatform: 'github' }));
    const pr = (deps.pullRequest as FakePullRequest).specs;
    assert.equal(pr[0]?.base, 'dev');
    assert.equal(pr[0]?.head, branch);
  }));

test('resume reuses the worktree still on disk, uncommitted work and all', () =>
  withTmp(async tmp => {
    const { deps, git, runtime } = makeDeps(
      new InMemoryGit({ branches: [branch] })
    );
    const params = resumeParams(tmp);
    const kept = path.join(params.worktreesDir, ...branch.split('/'));
    fs.mkdirSync(kept, { recursive: true });
    await runSpawn(deps, params);
    assert.deepEqual(git.checkedOut, []);
    assert.equal(runtime.options?.volumes?.[0]?.host, kept);
  }));

test('resume without a prompt reopens the session in the harness TUI', () =>
  withTmp(async tmp => {
    const { deps, runtime } = makeDeps(new InMemoryGit({ branches: [branch] }));
    await runSpawn(
      deps,
      resumeParams(tmp, { prompt: '', interactive: true, model: 'demo-pro' })
    );
    assert.deepEqual(runtime.command, ['demo', '--continue', '-m', 'demo-pro']);
  }));

test('resumePrompt says what happened, and falls back to "continue" without a follow-up', () => {
  assert.match(resumePrompt('add a test'), /resumed this run/);
  assert.ok(resumePrompt('add a test').endsWith('add a test'));
  assert.ok(resumePrompt('  ').endsWith(RESUME_DEFAULT_PROMPT));
  // The rules and the gate are restated, like every launch prompt.
  const gated = resumePrompt('x', 'parent', { command: 'npm test' });
  assert.ok(
    gated.startsWith(launchPrompt('', 'parent', { command: 'npm test' }))
  );
  assert.ok(gated.endsWith('x'));
});

test('every attempt of a resumed gated Run continues the session, with the feedback', () =>
  withTmp(async tmp => {
    const { deps, runtime } = makeDeps(
      new InMemoryGit({ branches: [branch], dirty: true })
    );
    // agent, red check, agent, green check
    runtime.exitCodes = [0, 1, 0, 0];
    runtime.outputs = ['FAIL: one test', ''];
    const result = await runSpawn(
      deps,
      resumeParams(tmp, { verify: { command: 'npm test' } })
    );
    assert.equal(result.outcome, 'verified');
    const agentRuns = runtime.runs.filter(
      r => !r.options.name?.endsWith('-verify')
    );
    assert.equal(agentRuns.length, 2);
    for (const r of agentRuns)
      assert.deepEqual(r.command.slice(0, 3), ['demo', '--continue', '-p']);
    assert.match(agentRuns[1].command[3], /FAIL: one test/);
  }));

test(
  'resume carries the wall clock over: the total timer is what is left of the budget',
  { timeout: 5000 },
  () =>
    withTmp(async tmp => {
      const { deps, runtime } = makeDeps(
        new InMemoryGit({ branches: [branch] }),
        new FakeRuntime(137)
      );
      let release: (() => void) | undefined;
      runtime.onRun = () =>
        new Promise<void>(resolve => {
          release = resolve;
        });
      const remove = runtime.removeContainer.bind(runtime);
      runtime.removeContainer = (name: string) => {
        remove(name);
        release?.();
      };
      const result = await runSpawn(
        deps,
        resumeParams(tmp, {
          verify: { command: 'npm test' },
          loop: {
            ...DEFAULT_LOOP_CAPS,
            totalTimeoutMs: 600_000,
            iterationTimeoutMs: 600_000,
          },
          // 20ms of the ten minutes are left.
          resume: { branch, base: recordedBase, elapsedMs: 600_000 - 20 },
        })
      );
      assert.equal(result.reason, 'exhausted:total-timeout');
      const record = readRunSession(path.join(tmp, '.e'), run);
      assert.ok(record!.elapsedMs >= 20, 'and adds what it spent');
    })
);

test('resume refuses a harness without the resume capability, before any worktree', () =>
  withTmp(async tmp => {
    const { deps, git, runtime } = makeDeps(
      new InMemoryGit({ branches: [branch] })
    );
    await assert.rejects(
      runSpawn(deps, resumeParams(tmp, { harness: demoHarness })),
      /cannot resume/
    );
    assert.deepEqual(git.checkedOut, []);
    assert.equal(runtime.ran, false);
  }));

test('resume refuses a branch of another agent, and one that is not a run branch', () =>
  withTmp(async tmp => {
    const { deps } = makeDeps(new InMemoryGit({ branches: [branch] }));
    await assert.rejects(
      runSpawn(
        deps,
        resumeParams(tmp, {
          agent: { name: 'other', harness: 'demo' },
        })
      ),
      /belongs to agent "demo"/
    );
    await assert.rejects(
      runSpawn(
        deps,
        resumeParams(tmp, {
          resume: { branch: 'main', base: recordedBase, elapsedMs: 0 },
        })
      ),
      /not a run branch/
    );
  }));

test('resume needs its session: one that cannot be opened fails the resume', () =>
  withTmp(async tmp => {
    const { deps, runtime } = makeDeps(new InMemoryGit({ branches: [branch] }));
    const params = resumeParams(tmp, {
      session: { storeDir: path.join(tmp, 'nope', '.e'), init },
    });
    fs.writeFileSync(path.join(tmp, 'nope'), 'a file');
    await assert.rejects(runSpawn(deps, params));
    assert.equal(runtime.ran, false);
  }));
