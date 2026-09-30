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
    // Announced before the first launch: the pinned base, every candidate queued.
    assert.deepEqual(events[0], {
      kind: 'prepared',
      fusion: FUSION,
      base: result.base,
      candidates: [
        { candidate: 'cand-001', agent: 'claude' },
        { candidate: 'cand-002', agent: 'codex' },
      ],
    });
    assert.deepEqual(
      events.map(e => `${e.kind}:${'candidate' in e ? e.candidate : ''}`),
      [
        'prepared:',
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
