import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HarnessAgent } from '../../core/agent/agent.js';
import type { FoundFusionProfile } from '../../core/fusion/load.js';
import type { FusionProfile } from '../../core/fusion/profile.js';
import { InMemoryGit } from '../../ports/git/memory.js';
import {
  readStatus,
  writeStatus,
} from '../../sidecars/broker/contract/spool.js';
import { Env } from '../../shared/utils/env.js';
import type {
  ChildHandle,
  ChildLaunch,
  ChildLauncher,
} from '../runs/childRun.js';
import type { Sleep } from './clock.js';
import { runFanOut, type FanOutDeps, type FanOutEvent } from './fanOut.js';
import { readCandidateResults, readFusionRecord } from './record.js';

/*
 * The fan-out (ADR-0019 sections 3, 4, 9): one prompt to every candidate
 * Agent, each an ordinary `e spawn` child cut from one pinned base, at most
 * `maxConcurrency` at a time and one image build at a time; every candidate
 * collected, whatever became of it; usable branches pushed when the fan-out
 * closes; a cancel stopping everything outstanding.
 */

const FUSION = 'fusion-01K6ZQ4W0R1X2Y3Z4A5B6C7D8E';
const agent = (name: string, harness = 'codex'): HarnessAgent => ({
  name,
  harness,
});

function found(
  candidates: string[],
  over: Partial<FusionProfile> = {}
): FoundFusionProfile {
  const profile: FusionProfile = {
    name: 'coding',
    candidates,
    synthesizer: 'claude',
    strategy: 'parallel-synthesize',
    maxConcurrency: Math.min(candidates.length, 3),
    minUsable: 1,
    ...over,
  };
  const agents = new Map<string, HarnessAgent>();
  for (const name of [...candidates, profile.synthesizer]) {
    agents.set(name, agent(name, name === 'claude' ? 'claudeCode' : 'codex'));
  }
  return { profile, agents };
}

/** How one scripted candidate behaves: when it reports, and how it ends. */
interface Script {
  /** The branch it reports; absent: it dies before it has one. */
  branch?: string;
  /** What the run reports as its exit code, and the process exits with. */
  exitCode?: number;
  /** Milliseconds before it reports `starting` (its image build). */
  buildMs?: number;
  /** Milliseconds it runs after that. */
  runMs?: number;
  /** Never ends on its own: only a kill stops it. */
  hang?: boolean;
  /** The launch itself throws. */
  launchFails?: string;
  /** Runs right after the child has ended on its own, in the same tick. */
  onEnd?: () => void;
  /** The reason its run reports, a `LoopReason`. */
  reason?: string;
  /** The verify verdict its run reports. */
  verify?: { verdict: 'green' | 'red' | 'broken'; attempts: number };
}

interface Scripted {
  launcher: ChildLauncher;
  launches: ChildLaunch[];
  /** The most children alive at once. */
  maxAlive: () => number;
  /** Status of every other launched candidate at the moment each launch happened. */
  seenAtLaunch: Map<string, (string | undefined)[]>;
  killed: string[];
}

function scripted(scripts: Record<string, Script>): Scripted {
  const launches: ChildLaunch[] = [];
  const seenAtLaunch = new Map<string, (string | undefined)[]>();
  const killed: string[] = [];
  let alive = 0;
  let maxAlive = 0;
  const launcher: ChildLauncher = launch => {
    const id = launch.request.id;
    const script = scripts[id] ?? {};
    if (script.launchFails) throw new Error(script.launchFails);
    seenAtLaunch.set(
      id,
      launches.map(
        other => readStatus(launch.spoolDir, other.request.id)?.status
      )
    );
    launches.push(launch);
    alive += 1;
    maxAlive = Math.max(maxAlive, alive);
    const report = (patch: Parameters<typeof writeStatus>[2]) =>
      writeStatus(launch.spoolDir, id, patch);
    const at = () => new Date().toISOString();
    let resolve!: (code: number) => void;
    const exited = new Promise<number>(r => (resolve = r));
    let ended = false;
    const end = (code: number) => {
      if (ended) return;
      ended = true;
      alive -= 1;
      resolve(code);
    };
    const timers: NodeJS.Timeout[] = [];
    timers.push(
      setTimeout(() => {
        if (script.branch === undefined) {
          report({
            status: 'failed',
            error: 'image build failed',
            updatedAt: at(),
          });
          end(script.exitCode ?? 1);
          return;
        }
        report({ status: 'starting', branch: script.branch, updatedAt: at() });
        report({ status: 'running', branch: script.branch, updatedAt: at() });
        if (script.hang) return;
        timers.push(
          setTimeout(() => {
            const code = script.exitCode ?? 0;
            report({
              status: 'done',
              branch: script.branch,
              exitCode: code,
              pushed: false,
              ...(script.reason ? { reason: script.reason } : {}),
              ...(script.verify ? { verify: script.verify } : {}),
              updatedAt: at(),
            });
            end(code);
            script.onEnd?.();
          }, script.runMs ?? 2)
        );
      }, script.buildMs ?? 2)
    );
    const handle: ChildHandle = {
      exited,
      kill: () => {
        killed.push(id);
        timers.forEach(clearTimeout);
        end(143);
      },
    };
    return handle;
  };
  return {
    launcher,
    launches,
    maxAlive: () => maxAlive,
    seenAtLaunch,
    killed,
  };
}

function withDirs(
  fn: (dirs: { storeDir: string; worktreesDir: string }) => Promise<void>
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-fanout-'));
  return fn({
    storeDir: path.join(root, '.e'),
    worktreesDir: path.join(root, 'worktrees'),
  }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

const tips = {
  'refs/heads/e/claude/add-retries-1': 'tip-claude',
  'refs/heads/e/codex/add-retries-1': 'tip-codex',
  'refs/heads/e/codex/add-retries-2': 'tip-codex-2',
};

/**
 * A clock the test moves: `now` reads it, `advance` moves it, and `sleep`
 * (for the loop's waits) moves it by exactly what the loop asked for, then
 * yields a macrotask so real-time scripted children still get to run.
 */
function clock(start = Date.parse('2026-09-30T10:00:00.000Z')) {
  let t = start;
  const sleep: Sleep = async ms => {
    t += ms;
    await new Promise(resolve => setImmediate(resolve));
  };
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
    sleep,
    start,
  };
}

function deps(
  dirs: { storeDir: string; worktreesDir: string },
  launcher: ChildLauncher,
  git = new InMemoryGit({
    headSha: 'pinned-sha',
    currentBranch: 'main',
    refCommits: tips,
  })
): FanOutDeps & { git: InMemoryGit } {
  return {
    git,
    storeDir: dirs.storeDir,
    worktreesDir: dirs.worktreesDir,
    launch: launcher,
    passthroughArgs: ['--dir', '/repo'],
    baseEnv: { PATH: '/bin', [Env.SPAWN_ROLE_VAR]: 'child' },
    pollIntervalMs: 1,
    newFusionId: () => FUSION,
  };
}

test('runFanOut: every candidate runs the same prompt from the same pinned base, side by side', async () => {
  await withDirs(async dirs => {
    const s = scripted({
      'cand-001': { branch: 'e/claude/add-retries-1', runMs: 20 },
      'cand-002': { branch: 'e/codex/add-retries-1', runMs: 20 },
    });
    const d = deps(dirs, s.launcher);
    const events: FanOutEvent[] = [];
    const result = await runFanOut(d, {
      found: found(['claude', 'codex']),
      prompt: 'Add retries',
      onEvent: event => events.push(event),
    });

    assert.equal(result.fusion, FUSION);
    assert.deepEqual(result.base, {
      sha: 'pinned-sha',
      ref: 'refs/heads/main',
      branch: 'main',
    });
    assert.equal(result.state, 'fanning-out');
    assert.equal(s.maxAlive(), 2, 'both ran at once');
    // Ordinary `e spawn` children, one per candidate, each told the base.
    for (const [i, name] of ['claude', 'codex'].entries()) {
      const launch = s.launches[i];
      assert.equal(launch.request.agent, name);
      assert.equal(launch.request.prompt, 'Add retries');
      assert.deepEqual(launch.args.slice(0, 2), ['spawn', name]);
      assert.deepEqual(launch.args.slice(-2), ['--', 'Add retries']);
      assert.ok(launch.args.includes('/repo'), 'the store passes through');
      assert.equal(launch.env[Env.SPAWN_FUSION_VAR], FUSION);
      assert.equal(launch.env[Env.SPAWN_FUSION_BASE_SHA_VAR], 'pinned-sha');
      assert.equal(launch.env[Env.SPAWN_FUSION_BASE_BRANCH_VAR], 'main');
      assert.equal(launch.env[Env.SPAWN_REPORT_ID_VAR], `cand-00${i + 1}`);
      // A candidate is a run of the user's own, not somebody's sibling.
      assert.equal(launch.env[Env.SPAWN_ROLE_VAR], undefined);
    }
    // Every candidate collected, usable ones pushed at the close.
    assert.deepEqual(
      result.candidates.map(c => [c.candidate, c.outcome, c.tip]),
      [
        ['cand-001', 'succeeded', 'tip-claude'],
        ['cand-002', 'succeeded', 'tip-codex'],
      ]
    );
    assert.equal(result.usable.length, 2);
    assert.deepEqual(d.git.pushed, [
      'e/claude/add-retries-1',
      'e/codex/add-retries-1',
    ]);
    assert.deepEqual(result.pushed, d.git.pushed);
    // The record says the same, and outlives this process.
    const record = readFusionRecord(dirs.storeDir, FUSION)!;
    assert.equal(record.state, 'fanning-out');
    assert.equal(record.prompt, 'Add retries');
    assert.deepEqual(record.candidates, ['cand-001', 'cand-002']);
    assert.equal(record.fanOut?.usable, 2);
    assert.equal(record.coordinator.pid, process.pid);
    assert.deepEqual(
      record.agents.map(a => a.name),
      ['claude', 'codex']
    );
    assert.equal(readCandidateResults(dirs.storeDir, FUSION).length, 2);
    // The fusion goes on to its synthesis: the spool and its logs stay until
    // the step that ends it removes them.
    assert.equal(
      result.spoolDir,
      path.join(dirs.worktreesDir, '.fusion', FUSION)
    );
    assert.equal(fs.existsSync(result.spoolDir), true);
    assert.deepEqual(
      events.map(e => `${e.kind}:${'candidate' in e ? e.candidate : ''}`),
      [
        'launched:cand-001',
        'launched:cand-002',
        'settled:cand-001',
        'settled:cand-002',
        'closed:',
      ]
    );
  });
});

test('runFanOut: one image build at a time; a second candidate of an Agent reuses the image', async () => {
  await withDirs(async dirs => {
    const s = scripted({
      'cand-001': { branch: 'e/codex/add-retries-1', buildMs: 15, runMs: 30 },
      'cand-002': { branch: 'e/codex/add-retries-2', buildMs: 5, runMs: 5 },
    });
    await runFanOut(deps(dirs, s.launcher), {
      found: found(['codex', 'codex']),
      prompt: 'Add retries',
    });
    // The second launched only once the first had built and cut its worktree.
    assert.deepEqual(s.seenAtLaunch.get('cand-002'), ['running']);
    assert.equal(s.launches[0].args.includes('--no-rebuild'), false);
    assert.equal(s.launches[1].args.includes('--no-rebuild'), true);
  });
});

test('runFanOut: maxConcurrency bounds the candidates alive at once', async () => {
  await withDirs(async dirs => {
    const s = scripted({
      'cand-001': { branch: 'e/claude/add-retries-1', runMs: 10 },
      'cand-002': { branch: 'e/codex/add-retries-1', runMs: 10 },
      'cand-003': { branch: 'e/codex/add-retries-2', runMs: 10 },
    });
    const result = await runFanOut(deps(dirs, s.launcher), {
      found: found(['claude', 'codex', 'codex'], { maxConcurrency: 1 }),
      prompt: 'Add retries',
    });
    assert.equal(s.maxAlive(), 1);
    assert.equal(s.launches.length, 3);
    assert.equal(result.usable.length, 3);
  });
});

test('runFanOut: a failed candidate is collected too, and discards nothing of the others', async () => {
  await withDirs(async dirs => {
    const s = scripted({
      'cand-001': {},
      'cand-002': { branch: 'e/codex/add-retries-1' },
      'cand-003': { launchFails: 'spawn EACCES' },
    });
    const d = deps(dirs, s.launcher);
    const result = await runFanOut(d, {
      found: found(['claude', 'codex', 'codex']),
      prompt: 'Add retries',
    });
    assert.equal(result.state, 'fanning-out');
    assert.deepEqual(
      result.candidates.map(c => [c.candidate, c.outcome, c.branch]),
      [
        ['cand-001', 'failed', null],
        ['cand-002', 'succeeded', 'e/codex/add-retries-1'],
        ['cand-003', 'failed', null],
      ]
    );
    assert.deepEqual(
      result.usable.map(c => c.candidate),
      ['cand-002']
    );
    assert.deepEqual(d.git.pushed, ['e/codex/add-retries-1']);
  });
});

test('runFanOut: fewer usable candidates than minUsable fails the fusion without a synthesis', async () => {
  await withDirs(async dirs => {
    const s = scripted({
      'cand-001': { branch: 'e/claude/add-retries-1' },
      // Exit 0 with no commits beyond the base: a refusal.
      'cand-002': { branch: 'e/codex/refused-1' },
    });
    const d = deps(dirs, s.launcher);
    const result = await runFanOut(d, {
      found: found(['claude', 'codex'], { minUsable: 2 }),
      prompt: 'Add retries',
    });
    assert.equal(result.state, 'failed');
    assert.equal(result.reason, 'aborted:no-usable-candidate');
    assert.equal(result.candidates[1].outcome, 'empty');
    // What is usable is still pushed: the fan-out closed before the verdict.
    assert.deepEqual(d.git.pushed, ['e/claude/add-retries-1']);
    const record = readFusionRecord(dirs.storeDir, FUSION)!;
    assert.equal(record.state, 'failed');
    assert.equal(record.reason, 'aborted:no-usable-candidate');
    assert.ok(record.endedAt);
    // It ended here, so its logs go with it.
    assert.equal(fs.existsSync(result.spoolDir), false);
  });
});

test('runFanOut: a cancel stops every candidate alive, launches none, and pushes nothing', async () => {
  await withDirs(async dirs => {
    const s = scripted({
      'cand-001': { branch: 'e/claude/add-retries-1', hang: true },
      'cand-002': { branch: 'e/codex/add-retries-1', hang: true },
      'cand-003': { branch: 'e/codex/add-retries-2' },
    });
    const d = deps(dirs, s.launcher);
    const abort = new AbortController();
    const done = runFanOut(d, {
      found: found(['claude', 'codex', 'codex'], { maxConcurrency: 2 }),
      prompt: 'Add retries',
      abort: abort.signal,
      onEvent: event => {
        if (event.kind === 'launched' && event.candidate === 'cand-002') {
          setTimeout(() => abort.abort(), 10);
        }
      },
    });
    const result = await done;
    assert.equal(result.state, 'canceled');
    assert.deepEqual(s.killed.sort(), ['cand-001', 'cand-002']);
    assert.equal(s.launches.length, 2, 'the third never started');
    assert.deepEqual(
      result.candidates.map(c => [c.candidate, c.outcome]),
      [
        ['cand-001', 'canceled'],
        ['cand-002', 'canceled'],
        ['cand-003', 'canceled'],
      ]
    );
    assert.deepEqual(d.git.pushed, []);
    const record = readFusionRecord(dirs.storeDir, FUSION)!;
    assert.equal(record.state, 'canceled');
    assert.ok(record.endedAt);
  });
});

test('runFanOut: a cancel before the first launch starts nothing', async () => {
  await withDirs(async dirs => {
    const s = scripted({});
    const abort = new AbortController();
    abort.abort();
    const result = await runFanOut(deps(dirs, s.launcher), {
      found: found(['claude', 'codex']),
      prompt: 'Add retries',
      abort: abort.signal,
    });
    assert.equal(result.state, 'canceled');
    assert.equal(s.launches.length, 0);
    assert.deepEqual(
      result.candidates.map(c => c.outcome),
      ['canceled', 'canceled']
    );
  });
});

test('runFanOut: a push that fails is a warning, not a failed fusion', async () => {
  await withDirs(async dirs => {
    const s = scripted({
      'cand-001': { branch: 'e/claude/add-retries-1' },
      'cand-002': { branch: 'e/codex/add-retries-1' },
    });
    const git = new InMemoryGit({
      headSha: 'pinned-sha',
      currentBranch: 'main',
      refCommits: tips,
      fail: { push: 'no remote' },
    });
    const result = await runFanOut(deps(dirs, s.launcher, git), {
      found: found(['claude', 'codex']),
      prompt: 'Add retries',
    });
    assert.equal(result.state, 'fanning-out');
    assert.deepEqual(result.pushed, []);
    assert.equal(result.pushWarnings.length, 2);
    assert.match(
      result.pushWarnings[0],
      /could not push e\/claude\/add-retries-1: no remote/
    );
  });
});

test('runFanOut: a detached HEAD has no branch to propose into, and nothing starts', async () => {
  await withDirs(async dirs => {
    const s = scripted({});
    const git = new InMemoryGit({ headSha: 'pinned-sha', currentBranch: '' });
    await assert.rejects(
      runFanOut(deps(dirs, s.launcher, git), {
        found: found(['claude', 'codex']),
        prompt: 'Add retries',
      }),
      /detached HEAD/
    );
    assert.equal(s.launches.length, 0);
  });
});

test('runFanOut: an empty prompt is refused before anything starts', async () => {
  await withDirs(async dirs => {
    const s = scripted({});
    await assert.rejects(
      runFanOut(deps(dirs, s.launcher), {
        found: found(['claude', 'codex']),
        prompt: '  ',
      }),
      /needs a prompt/
    );
  });
});

test("runFanOut: a dead coordinator's record is interrupted, an old one pruned, before a new fusion starts", async () => {
  await withDirs(async dirs => {
    const s = scripted({
      'cand-001': { branch: 'e/claude/add-retries-1' },
      'cand-002': { branch: 'e/codex/add-retries-1' },
    });
    const stale = 'fusion-01K6ZQ4W0R1X2Y3Z4A5B6C7D81';
    const d = { ...deps(dirs, s.launcher), isAlive: () => false };
    // A record a crashed coordinator left: live, its pid gone.
    const { writeFusionRecord } = await import('./record.js');
    writeFusionRecord(dirs.storeDir, {
      schemaVersion: 1,
      fusion: stale,
      state: 'fanning-out',
      profile: found(['claude', 'codex']).profile,
      agents: [],
      prompt: 'x',
      base: { sha: 's', ref: 'refs/heads/main', branch: 'main' },
      candidates: [],
      coordinator: { pid: 999_999 },
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
    });
    await runFanOut(d, {
      found: found(['claude', 'codex']),
      prompt: 'Add retries',
    });
    assert.equal(readFusionRecord(dirs.storeDir, stale)?.state, 'interrupted');
  });
});

test('runFanOut: --keep-worktree keeps the spool and its logs of a fusion that ended here', async () => {
  await withDirs(async dirs => {
    const s = scripted({
      'cand-001': { branch: 'e/claude/refused-1' },
      'cand-002': { branch: 'e/codex/refused-1' },
    });
    const result = await runFanOut(
      { ...deps(dirs, s.launcher), keepSpool: true },
      { found: found(['claude', 'codex']), prompt: 'Add retries' }
    );
    assert.equal(result.state, 'failed');
    assert.equal(readStatus(result.spoolDir, 'cand-001')?.status, 'done');
  });
});

test('runFanOut: a candidate whose branch cannot be read is collected as failed, and costs nothing else', async () => {
  await withDirs(async dirs => {
    const s = scripted({
      'cand-001': { branch: 'e/claude/add-retries-1' },
      'cand-002': { branch: 'e/codex/add-retries-1' },
    });
    class BrokenDiff extends InMemoryGit {
      override numstat(base: string, tip: string, pathspecs: string[]) {
        if (tip === 'tip-claude')
          throw new Error('fatal: bad object tip-claude');
        return super.numstat(base, tip, pathspecs);
      }
    }
    const git = new BrokenDiff({
      headSha: 'pinned-sha',
      currentBranch: 'main',
      refCommits: tips,
    });
    const result = await runFanOut(deps(dirs, s.launcher, git), {
      found: found(['claude', 'codex']),
      prompt: 'Add retries',
    });
    assert.equal(result.state, 'fanning-out');
    assert.deepEqual(
      result.candidates.map(c => [c.candidate, c.outcome, c.reason, c.tip]),
      [
        ['cand-001', 'failed', 'aborted:collect-failed', null],
        ['cand-002', 'succeeded', null, 'tip-codex'],
      ]
    );
    assert.deepEqual(git.pushed, ['e/codex/add-retries-1']);
  });
});

test('runFanOut: a candidate that finished just before a cancel is recorded as finished', async () => {
  await withDirs(async dirs => {
    const abort = new AbortController();
    const s = scripted({
      'cand-001': {
        branch: 'e/claude/add-retries-1',
        runMs: 5,
        onEnd: () => abort.abort(),
      },
      'cand-002': { branch: 'e/codex/add-retries-1', hang: true },
    });
    const result = await runFanOut(deps(dirs, s.launcher), {
      found: found(['claude', 'codex']),
      prompt: 'Add retries',
      abort: abort.signal,
    });
    assert.equal(result.state, 'canceled');
    assert.deepEqual(
      result.candidates.map(c => [c.candidate, c.outcome]),
      [
        ['cand-001', 'succeeded'],
        ['cand-002', 'canceled'],
      ]
    );
    assert.deepEqual(s.killed, ['cand-002']);
  });
});

test('runFanOut: a build that hangs past the gate no longer holds the other candidates back', async () => {
  await withDirs(async dirs => {
    const abort = new AbortController();
    const s = scripted({
      // Never reports `starting`: a build that hangs.
      'cand-001': { branch: 'e/claude/add-retries-1', buildMs: 60_000 },
      'cand-002': {
        branch: 'e/codex/add-retries-1',
        runMs: 1,
        onEnd: () => abort.abort(),
      },
    });
    const result = await runFanOut(
      { ...deps(dirs, s.launcher), buildGateMs: 20 },
      {
        found: found(['claude', 'codex']),
        prompt: 'Add retries',
        abort: abort.signal,
      }
    );
    assert.equal(s.launches.length, 2);
    assert.deepEqual(
      result.candidates.map(c => [c.candidate, c.outcome]),
      [
        ['cand-001', 'canceled'],
        ['cand-002', 'succeeded'],
      ]
    );
  });
});

test('runFanOut: whatever breaks the loop, no candidate outlives it and the record says so', async () => {
  await withDirs(async dirs => {
    const s = scripted({
      'cand-001': { branch: 'e/claude/add-retries-1', hang: true },
      'cand-002': { branch: 'e/codex/add-retries-1', hang: true },
    });
    await assert.rejects(
      runFanOut(deps(dirs, s.launcher), {
        found: found(['claude', 'codex']),
        prompt: 'Add retries',
        onEvent: event => {
          if (event.kind === 'launched' && event.candidate === 'cand-002') {
            throw new Error('renderer crashed');
          }
        },
      }),
      /renderer crashed/
    );
    assert.deepEqual(s.killed.sort(), ['cand-001', 'cand-002']);
    const record = readFusionRecord(dirs.storeDir, FUSION)!;
    assert.equal(record.state, 'failed');
    assert.equal(record.reason, 'aborted:fusion-coordinator');
    assert.ok(record.endedAt);
  });
});

// --- deadlines (ADR-0019 section 9) ------------------------------------------

test('runFanOut: candidatesMs times out every outstanding candidate, keeps their commits, and the fan-out closes', async () => {
  await withDirs(async dirs => {
    const c = clock();
    const s = scripted({
      // Committed before it hung: its work stays usable.
      'cand-001': { branch: 'e/claude/add-retries-1', hang: true },
      // Hung before its first commit.
      'cand-002': { branch: 'e/codex/refused-1', hang: true },
      // Never got a slot.
      'cand-003': { branch: 'e/codex/add-retries-2' },
    });
    const d = deps(dirs, s.launcher);
    const events: FanOutEvent[] = [];
    const result = await runFanOut(
      { ...d, now: c.now },
      {
        found: found(['claude', 'codex', 'codex'], {
          maxConcurrency: 2,
          timeouts: { candidatesMs: 60_000, totalMs: 120_000 },
        }),
        prompt: 'Add retries',
        onEvent: event => {
          events.push(event);
          if (event.kind === 'launched' && event.candidate === 'cand-002') {
            c.advance(60_000);
          }
        },
      }
    );
    assert.deepEqual(s.killed.sort(), ['cand-001', 'cand-002']);
    assert.equal(s.launches.length, 2, 'nothing starts past the deadline');
    assert.deepEqual(
      result.candidates.map(r => [r.candidate, r.outcome, r.tip]),
      [
        ['cand-001', 'timed-out', 'tip-claude'],
        ['cand-002', 'timed-out', null],
        ['cand-003', 'timed-out', null],
      ]
    );
    // The fan-out closed as usual: the quorum rule decides, usable is pushed.
    assert.equal(result.state, 'fanning-out');
    assert.deepEqual(d.git.pushed, ['e/claude/add-retries-1']);
    const exhausted = events.filter(e => e.kind === 'budget-exhausted');
    assert.deepEqual(exhausted, [
      {
        kind: 'budget-exhausted',
        budget: 'candidatesMs',
        limitMs: 60_000,
        stopped: ['cand-001', 'cand-002', 'cand-003'],
      },
    ]);
    // The status says who stopped it.
    assert.equal(readStatus(result.spoolDir, 'cand-001')?.status, 'canceled');
    assert.match(
      readStatus(result.spoolDir, 'cand-001')?.error ?? '',
      /canceled by the fusion's candidatesMs/
    );
    const record = readFusionRecord(dirs.storeDir, FUSION)!;
    assert.deepEqual(record.deadlines, {
      candidatesMs: 60_000,
      totalMs: 120_000,
      candidatesAt: '2026-09-30T10:01:00.000Z',
      totalAt: '2026-09-30T10:02:00.000Z',
    });
    assert.deepEqual(result.deadlines, record.deadlines);
  });
});

test('runFanOut: candidatesMs with nothing usable fails the fusion by the quorum rule', async () => {
  await withDirs(async dirs => {
    const c = clock();
    const s = scripted({
      'cand-001': { branch: 'e/claude/refused-1', hang: true },
      'cand-002': { branch: 'e/codex/refused-1', hang: true },
    });
    const result = await runFanOut(
      { ...deps(dirs, s.launcher), now: c.now },
      {
        found: found(['claude', 'codex'], {
          timeouts: { candidatesMs: 1_000 },
        }),
        prompt: 'Add retries',
        onEvent: event => {
          if (event.kind === 'launched' && event.candidate === 'cand-002') {
            c.advance(1_000);
          }
        },
      }
    );
    assert.equal(result.state, 'failed');
    assert.equal(result.reason, 'aborted:no-usable-candidate');
  });
});

test('runFanOut: totalMs stops everything, pushes nothing, and the fusion ends exhausted', async () => {
  await withDirs(async dirs => {
    const c = clock();
    const s = scripted({
      'cand-001': { branch: 'e/claude/add-retries-1', hang: true },
      'cand-002': { branch: 'e/codex/add-retries-1', hang: true },
      'cand-003': { branch: 'e/codex/add-retries-2' },
    });
    const d = deps(dirs, s.launcher);
    const events: FanOutEvent[] = [];
    const result = await runFanOut(
      { ...d, now: c.now },
      {
        found: found(['claude', 'codex', 'codex'], {
          maxConcurrency: 2,
          timeouts: { candidatesMs: 60_000, totalMs: 120_000 },
        }),
        prompt: 'Add retries',
        onEvent: event => {
          events.push(event);
          // Past both at once: the whole outranks the fan-out.
          if (event.kind === 'launched' && event.candidate === 'cand-002') {
            c.advance(120_000);
          }
        },
      }
    );
    assert.equal(result.state, 'exhausted');
    assert.equal(result.reason, 'exhausted:fusion-timeout');
    assert.deepEqual(s.killed.sort(), ['cand-001', 'cand-002']);
    // `canceled`, as ADR-0019 section 5 has it, and the reason says by what.
    assert.deepEqual(
      result.candidates.map(r => [r.candidate, r.outcome, r.reason]),
      [
        ['cand-001', 'canceled', 'exhausted:fusion-timeout'],
        ['cand-002', 'canceled', 'exhausted:fusion-timeout'],
        ['cand-003', 'canceled', 'exhausted:fusion-timeout'],
      ]
    );
    // The fan-out never closed: its branches stay local.
    assert.deepEqual(d.git.pushed, []);
    assert.deepEqual(
      events.filter(e => e.kind === 'budget-exhausted'),
      [
        {
          kind: 'budget-exhausted',
          budget: 'totalMs',
          limitMs: 120_000,
          stopped: ['cand-001', 'cand-002', 'cand-003'],
        },
      ]
    );
    const record = readFusionRecord(dirs.storeDir, FUSION)!;
    assert.equal(record.state, 'exhausted');
    assert.equal(record.reason, 'exhausted:fusion-timeout');
    assert.ok(record.endedAt);
    assert.equal(fs.existsSync(result.spoolDir), false, 'it ended here');
  });
});

test('runFanOut: totalMs that passes after candidatesMs, while the stopped ones wind down, still exhausts', async () => {
  await withDirs(async dirs => {
    const c = clock();
    let first = true;
    const slow: ChildLauncher = launch => {
      // A child that takes its time to die once killed: long enough, on
      // the fusion's clock, for the whole fusion's deadline to pass.
      const handle = s.launcher(launch);
      return {
        exited: handle.exited,
        kill: () => {
          if (first) c.advance(60_000);
          first = false;
          setTimeout(() => handle.kill(), 5);
        },
      };
    };
    const s = scripted({
      'cand-001': { branch: 'e/claude/add-retries-1', hang: true },
      'cand-002': { branch: 'e/codex/add-retries-1', hang: true },
    });
    const result = await runFanOut(
      { ...deps(dirs, slow), now: c.now },
      {
        found: found(['claude', 'codex'], {
          timeouts: { candidatesMs: 60_000, totalMs: 120_000 },
        }),
        prompt: 'Add retries',
        onEvent: event => {
          if (event.kind === 'launched' && event.candidate === 'cand-002') {
            c.advance(60_000);
          }
        },
      }
    );
    assert.equal(result.state, 'exhausted');
    assert.equal(result.reason, 'exhausted:fusion-timeout');
    // Each stopped once, by the deadline that reached it first.
    assert.deepEqual(
      result.candidates.map(r => r.outcome),
      ['timed-out', 'timed-out']
    );
  });
});

test("runFanOut: undeclared deadlines are derived from the Store's loop caps", async () => {
  await withDirs(async dirs => {
    const c = clock();
    const s = scripted({
      'cand-001': { branch: 'e/claude/add-retries-1' },
      'cand-002': { branch: 'e/codex/add-retries-1' },
      'cand-003': { branch: 'e/codex/add-retries-2' },
    });
    const result = await runFanOut(
      {
        ...deps(dirs, s.launcher),
        now: c.now,
        loop: { totalTimeoutMs: 1_000 },
      },
      {
        // Two rounds of a 1 s Run, and 15 min of margin each.
        found: found(['claude', 'codex', 'codex'], { maxConcurrency: 2 }),
        prompt: 'Add retries',
      }
    );
    assert.equal(result.state, 'fanning-out');
    assert.equal(result.deadlines?.candidatesMs, 2_000 + 15 * 60_000);
    assert.equal(
      result.deadlines?.totalMs,
      2_000 + 15 * 60_000 + 1_000 + 15 * 60_000
    );
    // Without the Store's caps, the built-in ones: 3 h per Run.
    const dirs2 = { ...dirs, storeDir: path.join(dirs.storeDir, 'other') };
    const s2 = scripted({
      'cand-001': { branch: 'e/claude/add-retries-1' },
      'cand-002': { branch: 'e/codex/add-retries-1' },
    });
    const plain = await runFanOut(deps(dirs2, s2.launcher), {
      found: found(['claude', 'codex']),
      prompt: 'Add retries',
    });
    assert.equal(plain.deadlines?.candidatesMs, 3 * 3_600_000 + 15 * 60_000);
  });
});

// --- retries (ADR-0019 section 9) --------------------------------------------

const retries = { maxAttempts: 2, backoffMs: 1_000, maxBackoffMs: 1_000 };

test('runFanOut: a failed launch is retried as a new record, after its backoff, and the first envelope stays', async () => {
  await withDirs(async dirs => {
    const c = clock();
    const s = scripted({
      'cand-001': { launchFails: 'provider unavailable' },
      'cand-002': { launchFails: 'provider unavailable' },
      'cand-003': { branch: 'e/claude/add-retries-1' },
      'cand-004': { branch: 'e/codex/add-retries-1' },
    });
    const events: FanOutEvent[] = [];
    const result = await runFanOut(
      {
        ...deps(dirs, s.launcher),
        now: c.now,
        sleep: c.sleep,
        random: () => 0.5,
      },
      {
        found: found(['claude', 'codex'], { retry: retries }),
        prompt: 'Add retries',
        onEvent: event => events.push(event),
      }
    );
    assert.equal(result.state, 'fanning-out');
    assert.deepEqual(
      result.candidates.map(r => [
        r.candidate,
        r.agent,
        r.outcome,
        r.attempt,
        r.retryOf,
      ]),
      [
        ['cand-001', 'claude', 'failed', 1, null],
        ['cand-002', 'codex', 'failed', 1, null],
        ['cand-003', 'claude', 'succeeded', 2, 'cand-001'],
        ['cand-004', 'codex', 'succeeded', 2, 'cand-002'],
      ]
    );
    // Half the backoff fixed, half jitter: 500 + 0.5 x 500.
    const scheduled = events.filter(e => e.kind === 'retry-scheduled');
    assert.deepEqual(
      scheduled.map(e => [e.candidate, e.retryOf, e.attempt, e.delayMs]),
      [
        ['cand-003', 'cand-001', 2, 750],
        ['cand-004', 'cand-002', 2, 750],
      ]
    );
    // It waited out exactly its backoff, on the injected clock.
    const retry = result.candidates[2];
    assert.equal(Date.parse(retry.startedAt), c.start + 750);
    assert.equal(
      scheduled[0].kind === 'retry-scheduled' && scheduled[0].notBefore,
      new Date(c.start + 750).toISOString()
    );
    assert.deepEqual(
      events
        .filter(e => e.kind === 'launched')
        .map(e => e.kind === 'launched' && [e.candidate, e.attempt, e.retryOf]),
      [
        ['cand-003', 2, 'cand-001'],
        ['cand-004', 2, 'cand-002'],
      ]
    );
    // Every attempt is its own record, never reused.
    const record = readFusionRecord(dirs.storeDir, FUSION)!;
    assert.deepEqual(record.candidates, [
      'cand-001',
      'cand-002',
      'cand-003',
      'cand-004',
    ]);
    assert.deepEqual(
      readCandidateResults(dirs.storeDir, FUSION).map(l => [
        l.candidate,
        l.result?.attempt,
      ]),
      [
        ['cand-001', 1],
        ['cand-002', 1],
        ['cand-003', 2],
        ['cand-004', 2],
      ]
    );
  });
});

test('runFanOut: retries stop at maxAttempts, and the last failure is terminal', async () => {
  await withDirs(async dirs => {
    const c = clock();
    const s = scripted({
      'cand-001': { launchFails: 'provider unavailable' },
      'cand-002': { branch: 'e/codex/add-retries-1' },
      'cand-003': { launchFails: 'provider unavailable' },
    });
    const events: FanOutEvent[] = [];
    const result = await runFanOut(
      {
        ...deps(dirs, s.launcher),
        now: c.now,
        sleep: c.sleep,
        random: () => 0,
      },
      {
        found: found(['claude', 'codex'], { retry: retries }),
        prompt: 'Add retries',
        onEvent: event => events.push(event),
      }
    );
    assert.deepEqual(
      result.candidates.map(r => [r.candidate, r.outcome, r.attempt]),
      [
        ['cand-001', 'failed', 1],
        ['cand-002', 'succeeded', 1],
        ['cand-003', 'failed', 2],
      ]
    );
    assert.deepEqual(
      events.filter(e => e.kind === 'retry-skipped'),
      [
        {
          kind: 'retry-skipped',
          candidate: 'cand-003',
          agent: 'claude',
          attempt: 2,
          why: 'max-attempts',
        },
      ]
    );
  });
});

test('runFanOut: a candidate with commits or a gate verdict is never retried; a harness exit is', async () => {
  await withDirs(async dirs => {
    const c = clock();
    const s = scripted({
      // Failed, but it committed: an attempt the synthesizer learns from.
      'cand-001': {
        branch: 'e/claude/add-retries-1',
        exitCode: 2,
        reason: 'exhausted:iterations',
      },
      // The repository's check said red: an answer, not an accident.
      'cand-002': {
        branch: 'e/codex/refused-1',
        exitCode: 2,
        verify: { verdict: 'red', attempts: 3 },
      },
      // The harness itself died before a commit.
      'cand-003': {
        branch: 'e/codex/refused-2',
        exitCode: 1,
        reason: 'aborted:harness-exit',
      },
      'cand-004': { branch: 'e/codex/add-retries-2' },
    });
    const result = await runFanOut(
      {
        ...deps(dirs, s.launcher),
        now: c.now,
        sleep: c.sleep,
        random: () => 0,
      },
      {
        found: found(['claude', 'codex', 'codex'], {
          retry: { ...retries, maxAttempts: 3 },
        }),
        prompt: 'Add retries',
      }
    );
    assert.deepEqual(
      result.candidates.map(r => [r.candidate, r.outcome, r.retryOf]),
      [
        ['cand-001', 'failed', null],
        ['cand-002', 'failed', null],
        ['cand-003', 'failed', null],
        ['cand-004', 'succeeded', 'cand-003'],
      ]
    );
  });
});

test('runFanOut: a retry never extends candidatesMs', async () => {
  await withDirs(async dirs => {
    const c = clock();
    const s = scripted({
      'cand-001': { launchFails: 'provider unavailable' },
      'cand-002': { branch: 'e/codex/add-retries-1' },
    });
    const events: FanOutEvent[] = [];
    const result = await runFanOut(
      {
        ...deps(dirs, s.launcher),
        now: c.now,
        sleep: c.sleep,
        random: () => 0,
      },
      {
        found: found(['claude', 'codex'], {
          // The backoff (at least 2.5 s) would end past the fan-out's 2 s.
          retry: { maxAttempts: 2, backoffMs: 5_000, maxBackoffMs: 5_000 },
          timeouts: { candidatesMs: 2_000, totalMs: 10_000 },
        }),
        prompt: 'Add retries',
        onEvent: event => events.push(event),
      }
    );
    assert.equal(result.candidates.length, 2, 'no retry was scheduled');
    assert.deepEqual(
      events
        .filter(e => e.kind === 'retry-skipped')
        .map(e => e.kind === 'retry-skipped' && [e.candidate, e.why]),
      [['cand-001', 'candidates-deadline']]
    );
  });
});

test('runFanOut: the classification is a seam a caller can replace', async () => {
  await withDirs(async dirs => {
    const c = clock();
    const s = scripted({
      // A refusal, which the default never retries.
      'cand-001': { branch: 'e/claude/refused-1' },
      'cand-002': { branch: 'e/codex/add-retries-1' },
      'cand-003': { branch: 'e/claude/add-retries-1' },
    });
    const seen: string[] = [];
    const result = await runFanOut(
      {
        ...deps(dirs, s.launcher),
        now: c.now,
        sleep: c.sleep,
        random: () => 0,
        classifyAttempt: r => {
          seen.push(r.candidate);
          return r.outcome === 'empty' ? 'retryable' : 'terminal';
        },
      },
      {
        found: found(['claude', 'codex'], { retry: retries }),
        prompt: 'Add retries',
      }
    );
    assert.deepEqual(
      result.candidates.map(r => [r.candidate, r.outcome, r.retryOf]),
      [
        ['cand-001', 'empty', null],
        ['cand-002', 'succeeded', null],
        ['cand-003', 'succeeded', 'cand-001'],
      ]
    );
    assert.deepEqual(seen.sort(), ['cand-001', 'cand-002', 'cand-003']);
  });
});

test('runFanOut: a cancel during a backoff cancels the retry too, and it says which attempt it was', async () => {
  await withDirs(async dirs => {
    const abort = new AbortController();
    const s = scripted({
      'cand-001': { launchFails: 'provider unavailable' },
      'cand-002': { branch: 'e/codex/add-retries-1', hang: true },
    });
    const result = await runFanOut(deps(dirs, s.launcher), {
      found: found(['claude', 'codex'], { retry: retries }),
      prompt: 'Add retries',
      abort: abort.signal,
      onEvent: event => {
        if (event.kind === 'retry-scheduled') abort.abort();
      },
    });
    assert.equal(result.state, 'canceled');
    assert.deepEqual(
      result.candidates.map(r => [
        r.candidate,
        r.outcome,
        r.attempt,
        r.retryOf,
      ]),
      [
        ['cand-001', 'failed', 1, null],
        ['cand-002', 'canceled', 1, null],
        ['cand-003', 'canceled', 2, 'cand-001'],
      ]
    );
    assert.equal(
      s.launches.some(l => l.request.id === 'cand-003'),
      false,
      'the retry never started'
    );
  });
});
