import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import {
  fuseEventLines,
  fuseExitCode,
  fusePassthroughArgs,
  fusePrompt,
  fuseReport,
  registerFuseCommand,
  runFuseCommand,
  type FuseCommandDeps,
  type FuseEvent,
  type FuseOutcome,
  fuseCancelHandling,
  FUSE_CANCEL_GRACE_MS,
} from './fuse.js';
import type { ReportLine } from './spawn.js';
import { CANCEL_GRACE_MS } from '../engine/runs/runSpawn.js';
import { FUSION_KILL_GRACE_MS } from '../engine/fusion/fanOut.js';
import { hostSlotsDir, type HostSlots } from '../engine/fusion/hostSlots.js';
import type { FusionProfile } from '../core/fusion/profile.js';
import type { CandidateResult } from '../core/fusion/result.js';
import { InMemoryGit } from '../ports/git/memory.js';
import { writeStatus } from '../sidecars/broker/contract/spool.js';
import { Env } from '../shared/utils/env.js';
import type {
  ChildHandle,
  ChildLaunch,
  ChildLauncher,
} from '../engine/runs/childRun.js';
import type { FanOutResult } from '../engine/fusion/fanOut.js';
import type { SynthesisResult } from '../engine/fusion/synthesis.js';
import { readFusionRecord } from '../engine/fusion/record.js';

/*
 * `e fuse` (ADR-0019 sections 3, 8, 9): every refusal before anything is
 * built, the two stages told apart in the output, the fusion's exit code,
 * and a cancel reaching both stages. The stages are the real ones where the
 * wiring matters, driven by a scripted child launcher, so no container
 * starts.
 */

const FUSION = 'fusion-01K6ZQ4W0R1X2Y3Z4A5B6C7D8E';

const MARKERS = [
  Env.SPAWN_PARENT_WORKTREE_VAR,
  Env.SPAWN_PARENT_BRANCH_VAR,
  Env.SPAWN_SPOOL_VAR,
  Env.SPAWN_SIBLING_ID_VAR,
  Env.SPAWN_FUSION_VAR,
  Env.SPAWN_FUSION_SYNTHESIS_VAR,
  Env.SPAWN_FUSION_MATERIAL_VAR,
  Env.SPAWN_FUSION_BASE_SHA_VAR,
  Env.SPAWN_FUSION_BASE_REF_VAR,
  Env.SPAWN_FUSION_BASE_BRANCH_VAR,
] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(MARKERS.map(name => [name, process.env[name]]));
  for (const name of MARKERS) delete process.env[name];
});
afterEach(() => {
  for (const name of MARKERS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const profile: FusionProfile = {
  name: 'coding',
  candidates: ['claudeCode', 'codex'],
  synthesizer: 'claudeCode',
  strategy: 'parallel-synthesize',
  maxConcurrency: 2,
  minUsable: 1,
};

function candidate(over: Partial<CandidateResult>): CandidateResult {
  return {
    schemaVersion: 1,
    fusion: FUSION,
    candidate: 'cand-001',
    agent: 'claudeCode',
    harness: { name: 'claudeCode', version: '1' },
    provider: null,
    skills: [],
    mcp: [],
    base: { sha: 'pinned', branch: 'main' },
    branch: null,
    tip: null,
    changes: { files: [], added: 0, removed: 0 },
    patch: null,
    patchTruncated: false,
    files: null,
    filesTruncated: false,
    outcome: 'succeeded',
    exitCode: 0,
    reason: null,
    attempt: 1,
    retryOf: null,
    startedAt: 't',
    endedAt: 't',
    elapsedMs: 0,
    usage: null,
    ...over,
  };
}

const succeeded = candidate({
  branch: 'e/claudeCode/add-retries-1',
  tip: 'tip-1',
  changes: {
    files: [{ path: 'src/a.ts', added: 41, removed: 3 }],
    added: 41,
    removed: 3,
  },
  verify: { verdict: 'green', attempts: 2 },
});
const failed = candidate({
  candidate: 'cand-002',
  agent: 'codex',
  outcome: 'failed',
  exitCode: 1,
  reason: 'aborted:harness-exit',
});

function fanOut(over: Partial<FanOutResult> = {}): FanOutResult {
  return {
    fusion: FUSION,
    base: { sha: 'pinned', ref: 'refs/heads/main', branch: 'main' },
    state: 'fanning-out',
    candidates: [succeeded, failed],
    usable: [succeeded],
    pushed: ['e/claudeCode/add-retries-1'],
    pushWarnings: [],
    spoolDir: '/nowhere',
    ...over,
  };
}

function synthesis(over: Partial<SynthesisResult> = {}): SynthesisResult {
  return {
    fusion: FUSION,
    state: 'completed',
    exitCode: 0,
    branch: 'e/claudeCode/add-retries-2',
    pushed: true,
    pullRequestUrl: 'https://example.test/pr/7',
    ...over,
  };
}

const texts = (lines: ReportLine[]) => lines.map(line => line.text);

// --- the pure parts --------------------------------------------------------

test('fusePrompt: the words are the task; none is refused, since a fusion is never interactive', () => {
  assert.equal(fusePrompt('coding', ['add', ' retries ']), 'add  retries');
  assert.throws(
    () => fusePrompt('coding', []),
    /e fuse needs a prompt.*non-interactively.*e fuse coding "<task>"/
  );
  assert.throws(() => fusePrompt('coding', ['  ']), /needs a prompt/);
});

test('fusePassthroughArgs: the Store, the env file and the one resolved runtime reach every child', () => {
  assert.deepEqual(
    fusePassthroughArgs({ dir: '/repo', envFile: '/secrets.env' }, 'podman'),
    ['--dir', '/repo', '--env-file', '/secrets.env', '--runtime', 'podman']
  );
  assert.deepEqual(fusePassthroughArgs({}, 'docker'), ['--runtime', 'docker']);
});

test('fuseExitCode: the synthesis Verdict when it ran, else 1, 143 on a cancel and 2 when totalMs fired', () => {
  const cases: [FuseOutcome, number][] = [
    [{ fanOut: fanOut(), synthesis: synthesis() }, 0],
    [{ fanOut: fanOut(), synthesis: synthesis({ exitCode: 1 }) }, 1],
    [{ fanOut: fanOut(), synthesis: synthesis({ exitCode: 2 }) }, 2],
    [
      {
        fanOut: fanOut(),
        synthesis: synthesis({ state: 'canceled', exitCode: 143 }),
      },
      143,
    ],
    [
      {
        fanOut: fanOut(),
        synthesis: synthesis({ state: 'exhausted', exitCode: 2 }),
      },
      2,
    ],
    [
      {
        fanOut: fanOut({
          state: 'failed',
          reason: 'aborted:no-usable-candidate',
        }),
      },
      1,
    ],
    [{ fanOut: fanOut({ state: 'canceled' }) }, 143],
    [
      {
        fanOut: fanOut({
          state: 'exhausted',
          reason: 'exhausted:fusion-timeout',
        }),
      },
      2,
    ],
    [{ fanOut: fanOut({ state: 'interrupted' }) }, 1],
    // A fan-out that could synthesize but did not has no result either.
    [{ fanOut: fanOut() }, 1],
  ];
  for (const [outcome, code] of cases) {
    assert.equal(
      fuseExitCode(outcome),
      code,
      JSON.stringify([outcome.fanOut.state, outcome.synthesis?.state])
    );
  }
});

test('fuseEventLines: the pinned base, candidates and synthesizer up front, then each stage under its own tag', () => {
  const events: FuseEvent[] = [
    {
      kind: 'prepared',
      fusion: FUSION,
      base: { sha: 'pinned-sha', ref: 'refs/heads/main', branch: 'main' },
      candidates: [
        { candidate: 'cand-001', agent: 'claudeCode' },
        { candidate: 'cand-002', agent: 'codex' },
      ],
    },
    {
      kind: 'launched',
      candidate: 'cand-001',
      agent: 'claudeCode',
      attempt: 1,
    },
    { kind: 'launched', candidate: 'cand-002', agent: 'codex', attempt: 1 },
    { kind: 'settled', candidate: 'cand-001', result: succeeded },
    { kind: 'settled', candidate: 'cand-002', result: failed },
    {
      kind: 'closed',
      usable: 1,
      pushed: ['e/claudeCode/add-retries-1'],
      pushWarnings: ['could not push x: denied'],
    },
    { kind: 'synthesis-launched', id: 'syn-001', agent: 'claudeCode' },
    { kind: 'synthesis-settled', id: 'syn-001', exitCode: 0 },
  ];
  const lines = events.flatMap(event => fuseEventLines(event, profile));
  assert.deepEqual(texts(lines), [
    `Fusion ${FUSION} (profile coding)`,
    'Pinned base: main @ pinned-sha',
    'Candidates: claudeCode, codex (at most 2 at a time; the synthesis needs 1 usable)',
    'Synthesizer: claudeCode',
    '[candidates] cand-001 claudeCode: queued',
    '[candidates] cand-002 codex: queued',
    '[candidates] cand-001 claudeCode: running',
    '[candidates] cand-002 codex: running',
    '[candidates] cand-001 claudeCode: succeeded (e/claudeCode/add-retries-1, 1 file +41 -3, verify green)',
    '[candidates] cand-002 codex: failed (exit 1, aborted:harness-exit)',
    '[candidates] closed: 1 usable; pushed e/claudeCode/add-retries-1',
    'Warning: could not push x: denied',
    '[synthesis] syn-001 claudeCode: running',
    '[synthesis] syn-001 claudeCode: succeeded',
  ]);
  // Plain lines, no TTY tricks: nothing but text, one state change each.
  for (const line of lines) {
    assert.ok(!line.text.includes('\r') && !line.text.includes('\u001b'));
  }
  assert.equal(lines[8].level, 'success');
  assert.equal(lines[11].level, 'warn');
});

test('fuseEventLines: every candidate outcome and synthesis Verdict has its own label', () => {
  const line = (over: Partial<CandidateResult>) =>
    fuseEventLines(
      { kind: 'settled', candidate: 'cand-003', result: candidate(over) },
      profile
    )[0].text;
  assert.equal(
    line({ outcome: 'empty' }),
    '[candidates] cand-001 claudeCode: empty'
  );
  assert.equal(
    line({ outcome: 'timed-out', exitCode: 143 }),
    '[candidates] cand-001 claudeCode: timed-out'
  );
  assert.equal(
    line({ outcome: 'canceled', exitCode: 143 }),
    '[candidates] cand-001 claudeCode: canceled'
  );
  // A retry (#178) says which attempt it is.
  assert.equal(
    line({ candidate: 'cand-003', attempt: 2, retryOf: 'cand-001' }),
    '[candidates] cand-003 claudeCode: succeeded (attempt 2, retry of cand-001)'
  );
  assert.equal(
    fuseEventLines(
      {
        kind: 'closed',
        usable: 0,
        pushed: [],
        pushWarnings: [],
      },
      profile
    )[0].text,
    '[candidates] closed: 0 usable; nothing pushed'
  );
  const verdict = (exitCode: number) =>
    fuseEventLines(
      { kind: 'synthesis-settled', id: 'syn-001', exitCode },
      profile
    )[0].text;
  assert.equal(verdict(1), '[synthesis] syn-001 claudeCode: aborted (exit 1)');
  assert.equal(
    verdict(2),
    '[synthesis] syn-001 claudeCode: exhausted (exit 2)'
  );
  assert.equal(verdict(143), '[synthesis] syn-001 claudeCode: canceled');
});

test('fuseReport: a completed fusion ends like a run - pushed, its PR, and the Run branch last', () => {
  const lines = fuseReport(
    { fanOut: fanOut(), synthesis: synthesis() },
    profile,
    '/store/.e'
  );
  assert.deepEqual(texts(lines), [
    '\nCandidates: 1 succeeded, 1 failed (1 of 2 usable).',
    'Synthesis succeeded.',
    'Pushed to origin. Open a PR or merge when you like.',
    'Pull request: https://example.test/pr/7',
    `Fusion record: ${path.join('/store/.e', 'runs', 'fusions', FUSION)}`,
    '\nRun branch: e/claudeCode/add-retries-2',
  ]);
  const red = fuseReport(
    {
      fanOut: fanOut(),
      synthesis: synthesis({
        exitCode: 2,
        reason: 'exhausted:iterations',
        pushed: false,
        pullRequestUrl: undefined,
      }),
    },
    profile,
    '/store/.e'
  );
  assert.equal(red[1].text, 'Synthesis exhausted (exhausted:iterations).');
  assert.equal(red[1].level, 'warn');
  assert.equal(red.at(-1)?.text, '\nRun branch: e/claudeCode/add-retries-2');
  assert.ok(!texts(red).some(text => text.startsWith('Pull request')));
});

test('fuseReport: a fusion that ends without a synthesis says why', () => {
  const noUsable = fuseReport(
    {
      fanOut: fanOut({
        state: 'failed',
        reason: 'aborted:no-usable-candidate',
        candidates: [failed],
        usable: [],
      }),
    },
    { minUsable: 2 },
    '/store/.e'
  );
  assert.equal(noUsable[0].text, '\nCandidates: 1 failed (0 of 1 usable).');
  assert.deepEqual(noUsable[1], {
    level: 'error',
    text: 'Fusion failed (aborted:no-usable-candidate): 0 usable, the profile needs 2. No synthesis ran.',
  });
  assert.ok(!texts(noUsable).some(text => text.includes('Run branch')));

  const canceled = fuseReport(
    { fanOut: fanOut({ state: 'canceled' }) },
    profile,
    '/store/.e'
  );
  assert.equal(
    canceled[1].text,
    'Fusion canceled before its synthesis; nothing was pushed.'
  );
  const exhausted = fuseReport(
    { fanOut: fanOut({ state: 'exhausted' }) },
    profile,
    '/store/.e'
  );
  assert.equal(
    exhausted[1].text,
    'Fusion exhausted (exhausted:fusion-timeout): no synthesis, no PR.'
  );
  const other = fuseReport(
    { fanOut: fanOut({ state: 'interrupted' }) },
    profile,
    '/store/.e'
  );
  assert.equal(other[1].text, 'Fusion interrupted: no synthesis ran.');
  const empty = fuseReport(
    { fanOut: fanOut({ state: 'canceled', candidates: [], usable: [] }) },
    profile,
    '/store/.e'
  );
  assert.equal(empty[0].text, '\nCandidates: none (0 of 0 usable).');
});

// --- the action -----------------------------------------------------------

/** A Store holding the `coding` profile (and whatever `extra` adds), torn down after. */
async function withStore(
  fn: (root: string) => Promise<void>,
  body: object = {
    candidates: ['claudeCode', 'codex'],
    synthesizer: 'claudeCode',
  }
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-fuse-'));
  try {
    const file = path.join(root, '.e', 'fusions', 'coding', 'fusion.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(body));
    await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Deps whose stages must never be reached: a refusal starts nothing. */
function refusingDeps(printed: ReportLine[]): FuseCommandDeps & {
  git: InMemoryGit;
} {
  return {
    git: new InMemoryGit(),
    resolveRuntime: () => ({ engine: 'docker' }),
    fanOut: () => assert.fail('the fan-out must not start'),
    synthesis: () => assert.fail('the synthesis must not start'),
    launch: () => assert.fail('nothing may launch'),
    print: line => printed.push(line),
  };
}

test('runFuseCommand: an invalid profile fails before any worktree, container or git call', async () => {
  await withStore(
    async root => {
      const printed: ReportLine[] = [];
      const deps = refusingDeps(printed);
      const code = await runFuseCommand(
        'coding',
        ['add', 'retries'],
        { dir: root },
        deps
      );
      assert.equal(code, 1);
      assert.match(printed[0].text, /fewer|two|2|candidates/i);
      assert.equal(printed[0].level, 'error');
      assert.deepEqual(deps.git.calls, [], 'not even git was asked');

      const unknown: ReportLine[] = [];
      assert.equal(
        await runFuseCommand(
          'nope',
          ['x'],
          { dir: root },
          refusingDeps(unknown)
        ),
        1
      );
      assert.match(
        unknown[0].text,
        /Unknown fusion profile "nope". Available: coding/
      );
    },
    { candidates: ['claudeCode'], synthesizer: 'claudeCode' }
  );
});

test('runFuseCommand: a missing prompt, a directory outside git, and no runtime are refused before anything starts', async () => {
  await withStore(async root => {
    const noPrompt: ReportLine[] = [];
    assert.equal(
      await runFuseCommand('coding', [], { dir: root }, refusingDeps(noPrompt)),
      1
    );
    assert.match(noPrompt[0].text, /e fuse needs a prompt/);

    const noRepo: ReportLine[] = [];
    const outside = refusingDeps(noRepo);
    outside.git = new InMemoryGit({ repo: false });
    assert.equal(
      await runFuseCommand('coding', ['go'], { dir: root }, outside),
      1
    );
    assert.match(noRepo[0].text, /inside a git repository/);

    const noRuntime: ReportLine[] = [];
    const runtimeless = refusingDeps(noRuntime);
    runtimeless.resolveRuntime = preferred => {
      throw new Error(`Invalid runtime "${preferred}"`);
    };
    assert.equal(
      await runFuseCommand(
        'coding',
        ['go'],
        { dir: root, runtime: 'bogus' },
        runtimeless
      ),
      1
    );
    assert.match(noRuntime[0].text, /Invalid runtime "bogus"/);
  });
});

test('runFuseCommand: a run cannot start a fusion; only the host does', async () => {
  await withStore(async root => {
    process.env[Env.SPAWN_PARENT_WORKTREE_VAR] = '/parent';
    process.env[Env.SPAWN_PARENT_BRANCH_VAR] = 'e/pi/x-1';
    process.env[Env.SPAWN_SPOOL_VAR] = '/spool';
    process.env[Env.SPAWN_SIBLING_ID_VAR] = 'sib-001';
    const printed: ReportLine[] = [];
    assert.equal(
      await runFuseCommand(
        'coding',
        ['go'],
        { dir: root },
        refusingDeps(printed)
      ),
      1
    );
    assert.match(printed[0].text, /started by the host only/);
  });
});

test('runFuseCommand: the stages get the Store, the passthrough, the spool policy and the one cancel', async () => {
  await withStore(async root => {
    const printed: ReportLine[] = [];
    const abort = new AbortController().signal;
    const launch: ChildLauncher = () => assert.fail('scripted stages');
    const seen: Record<string, unknown> = {};
    const code = await runFuseCommand(
      'coding',
      ['add', 'retries'],
      { dir: root, envFile: '/x.env', runtime: 'podman', keepWorktree: true },
      {
        git: new InMemoryGit(),
        abort,
        launch,
        worktreesDir: '/wt',
        resolveRuntime: preferred => ({ engine: preferred! }),
        fanOut: async (deps, params) => {
          seen.fanOut = { deps, params };
          return fanOut();
        },
        synthesis: async (deps, params) => {
          seen.synthesis = { deps, params };
          return synthesis({ exitCode: 2, state: 'completed' });
        },
        print: line => printed.push(line),
      }
    );
    assert.equal(code, 2, "the synthesis Verdict is the fusion's exit code");
    const f = seen.fanOut as {
      deps: Record<string, unknown>;
      params: Record<string, unknown>;
    };
    assert.equal(f.deps.storeDir, path.join(root, '.e'));
    assert.equal(f.deps.worktreesDir, '/wt');
    assert.equal(f.deps.launch, launch);
    assert.equal(f.deps.keepSpool, true);
    assert.deepEqual(f.deps.passthroughArgs, [
      '--dir',
      root,
      '--env-file',
      '/x.env',
      '--runtime',
      'podman',
    ]);
    assert.equal(f.params.prompt, 'add retries');
    assert.equal(f.params.abort, abort);
    assert.equal(
      (f.params.found as { profile: FusionProfile }).profile.name,
      'coding'
    );
    const s = seen.synthesis as {
      deps: Record<string, unknown>;
      params: Record<string, unknown>;
    };
    assert.equal(s.params.abort, abort);
    assert.equal((s.params.fanOut as FanOutResult).fusion, FUSION);
    assert.deepEqual(s.deps.passthroughArgs, f.deps.passthroughArgs);
    assert.equal(s.deps.keepSpool, true);
    assert.equal(
      printed.at(-1)?.text,
      '\nRun branch: e/claudeCode/add-retries-2'
    );
  });
});

test('runFuseCommand: a fan-out that fails or is canceled starts no synthesis', async () => {
  await withStore(async root => {
    for (const [state, code] of [
      ['failed', 1],
      ['canceled', 143],
      // totalMs fired during the fan-out (#178): no synthesis, no PR.
      ['exhausted', 2],
    ] as const) {
      const printed: ReportLine[] = [];
      const deps = refusingDeps(printed);
      deps.fanOut = async () =>
        fanOut({
          state,
          ...(state === 'failed'
            ? { reason: 'aborted:no-usable-candidate' }
            : state === 'exhausted'
              ? { reason: 'exhausted:fusion-timeout' }
              : {}),
        });
      assert.equal(
        await runFuseCommand('coding', ['go'], { dir: root }, deps),
        code
      );
    }
  });
});

/** A scripted `e spawn` child: reports its branch and ends, or hangs until killed. */
function scriptedChildren(endings: Record<string, { hang?: boolean }> = {}) {
  const launches: ChildLaunch[] = [];
  const killed: string[] = [];
  const launch: ChildLauncher = l => {
    launches.push(l);
    const id = l.request.id;
    const synthesis = id.startsWith('syn-');
    const branch = synthesis
      ? 'e/claudeCode/add-retries-3'
      : `e/${l.request.agent}/add-retries-${id === 'cand-001' ? 1 : 2}`;
    let resolve!: (code: number) => void;
    const exited = new Promise<number>(r => (resolve = r));
    const at = () => new Date().toISOString();
    const timer = setTimeout(() => {
      writeStatus(l.spoolDir, id, {
        status: 'starting',
        branch,
        updatedAt: at(),
      });
      if (endings[id]?.hang) return;
      writeStatus(l.spoolDir, id, {
        status: 'done',
        branch,
        exitCode: 0,
        pushed: synthesis,
        ...(synthesis ? { pullRequestUrl: 'https://example.test/pr/9' } : {}),
        updatedAt: at(),
      });
      resolve(0);
    }, 3);
    const handle: ChildHandle = {
      exited,
      kill: () => {
        killed.push(id);
        clearTimeout(timer);
        resolve(143);
      },
    };
    return handle;
  };
  return { launch, launches, killed };
}

function realStageGit(): InMemoryGit {
  return new InMemoryGit({
    headSha: 'pinned-sha',
    currentBranch: 'main',
    refCommits: {
      'refs/heads/e/claudeCode/add-retries-1': 'tip-1',
      'refs/heads/e/codex/add-retries-2': 'tip-2',
    },
  });
}

test('runFuseCommand: the real stages, end to end - candidates, then the synthesis, then its PR', async () => {
  await withStore(async root => {
    const children = scriptedChildren();
    const printed: ReportLine[] = [];
    const git = realStageGit();
    const code = await runFuseCommand(
      'coding',
      ['add retries'],
      { dir: root },
      {
        git,
        launch: children.launch,
        worktreesDir: path.join(root, 'wt'),
        resolveRuntime: () => ({ engine: 'docker' }),
        print: line => printed.push(line),
      }
    );
    assert.equal(code, 0);
    assert.deepEqual(
      children.launches.map(l => [l.request.id, l.request.agent]),
      [
        ['cand-001', 'claudeCode'],
        ['cand-002', 'codex'],
        ['syn-001', 'claudeCode'],
      ]
    );
    for (const l of children.launches) {
      assert.ok(l.args.includes('--runtime'), 'the runtime passes through');
    }
    const lines = texts(printed);
    const at = (text: string | RegExp) =>
      lines.findIndex(line =>
        typeof text === 'string' ? line === text : text.test(line)
      );
    // Header first, every candidate line before the first synthesis line.
    assert.match(lines[0], /^Fusion fusion-\S+ \(profile coding\)$/);
    assert.equal(lines[1], 'Pinned base: main @ pinned-sha');
    const lastCandidate =
      lines.length -
      1 -
      [...lines].reverse().findIndex(l => l.startsWith('[candidates]'));
    const firstSynthesis = at(/^\[synthesis\]/);
    assert.ok(lastCandidate < firstSynthesis);
    assert.ok(
      at('[candidates] cand-002 codex: queued') <
        at('[candidates] cand-002 codex: running')
    );
    assert.ok(at(/^\[candidates\] cand-001 claudeCode: succeeded/) > 0);
    assert.ok(at('[synthesis] syn-001 claudeCode: succeeded') > firstSynthesis);
    assert.ok(at('Pull request: https://example.test/pr/9') > 0);
    assert.equal(lines.at(-1), '\nRun branch: e/claudeCode/add-retries-3');
    // The record in the Store says the fusion completed.
    const fusion = lines[0].split(' ')[1];
    assert.equal(
      readFusionRecord(path.join(root, '.e'), fusion)?.state,
      'completed'
    );
  });
});

test('runFuseCommand: a cancel mid-fan-out kills every child, starts no synthesis, and exits 143', async () => {
  await withStore(async root => {
    const children = scriptedChildren({
      'cand-001': { hang: true },
      'cand-002': { hang: true },
    });
    const cancel = new AbortController();
    const printed: ReportLine[] = [];
    const code = await runFuseCommand(
      'coding',
      ['add retries'],
      { dir: root },
      {
        git: realStageGit(),
        abort: cancel.signal,
        launch: children.launch,
        worktreesDir: path.join(root, 'wt'),
        resolveRuntime: () => ({ engine: 'docker' }),
        print: line => {
          printed.push(line);
          // Ctrl-C once the first candidate is running.
          if (line.text.endsWith(': running')) cancel.abort();
        },
      }
    );
    assert.equal(code, 143);
    assert.deepEqual(children.killed, ['cand-001']);
    assert.ok(!children.launches.some(l => l.request.id.startsWith('syn-')));
    const lines = texts(printed);
    // Whether it had cut its branch yet depends on how fast the cancel won.
    assert.ok(
      lines.some(line =>
        line.startsWith('[candidates] cand-001 claudeCode: canceled')
      ),
      lines.join('\n')
    );
    assert.ok(lines.includes('[candidates] cand-002 codex: canceled'));
    assert.ok(
      lines.includes(
        'Fusion canceled before its synthesis; nothing was pushed.'
      )
    );
  });
});

test('registerFuseCommand: e fuse <profile> [prompt...] with the flags a candidate inherits', () => {
  const program = new Command();
  registerFuseCommand(program);
  const fuse = program.commands.find(c => c.name() === 'fuse')!;
  assert.deepEqual(
    fuse.registeredArguments.map(a => [a.name(), a.required, a.variadic]),
    [
      ['profile', true, false],
      ['prompt', false, true],
    ]
  );
  assert.deepEqual(
    fuse.options.map(o => o.long),
    ['--runtime', '--env-file', '--dir', '--keep-worktree']
  );
});

test('fuseEventLines: retries and exhausted budgets are said in their stage', () => {
  const lines = (event: FuseEvent) =>
    fuseEventLines(event, {
      name: 'coding',
      synthesizer: 'claudeCode',
      maxConcurrency: 2,
      minUsable: 1,
    }).map(line => line.text);
  assert.deepEqual(
    lines({
      kind: 'launched',
      candidate: 'cand-003',
      agent: 'codex',
      attempt: 2,
      retryOf: 'cand-002',
    }),
    ['[candidates] cand-003 codex: running (attempt 2, retry of cand-002)']
  );
  assert.deepEqual(
    lines({
      kind: 'retry-scheduled',
      candidate: 'cand-003',
      agent: 'codex',
      attempt: 2,
      retryOf: 'cand-002',
      delayMs: 30000,
      notBefore: '2026-09-30T10:00:30.000Z',
    }),
    [
      '[candidates] cand-003 codex: queued (attempt 2, retry of cand-002, not before 2026-09-30T10:00:30.000Z)',
    ]
  );
  assert.deepEqual(
    lines({
      kind: 'retry-skipped',
      candidate: 'cand-002',
      agent: 'codex',
      attempt: 3,
      why: 'max-attempts',
    }),
    ['[candidates] cand-002 codex: no retry (attempt 3 was the last allowed)']
  );
  assert.deepEqual(
    lines({
      kind: 'retry-skipped',
      candidate: 'cand-002',
      agent: 'codex',
      attempt: 1,
      why: 'candidates-deadline',
    }),
    [
      "[candidates] cand-002 codex: no retry (it could not start before the fusion's deadline)",
    ]
  );
  assert.deepEqual(
    lines({
      kind: 'budget-exhausted',
      budget: 'candidatesMs',
      limitMs: 1000,
      stopped: ['cand-001'],
    }),
    ['[candidates] candidatesMs (1000 ms) exhausted: stopped cand-001']
  );
  assert.deepEqual(
    lines({
      kind: 'budget-exhausted',
      budget: 'totalMs',
      limitMs: 5000,
      stopped: [],
    }),
    ['[fusion] totalMs (5000 ms) exhausted']
  );
  assert.deepEqual(
    lines({
      kind: 'host-slot-wait',
      candidate: 'cand-002',
      agent: 'codex',
      limit: 4,
    }),
    [
      '[candidates] cand-002 codex: waiting for a host slot (fusion.hostConcurrency 4, shared with every e fuse on this host)',
    ]
  );
});

test("runFuseCommand: config.json's fusion.hostConcurrency bounds the fan-out host-wide, through the worktrees dir", async () => {
  await withStore(async root => {
    const seen: unknown[] = [];
    const run = async () => {
      const deps = refusingDeps([]);
      deps.worktreesDir = path.join(root, 'worktrees');
      deps.fanOut = async d => {
        seen.push(d.hostSlots);
        return fanOut({ state: 'canceled' });
      };
      await runFuseCommand('coding', ['go'], { dir: root }, deps);
    };
    // Unset: only the profile's maxConcurrency bounds.
    await run();
    fs.writeFileSync(
      path.join(root, '.e', 'config.json'),
      JSON.stringify({ fusion: { hostConcurrency: 4 } })
    );
    await run();
    assert.equal(seen[0], undefined);
    const slots = seen[1] as HostSlots;
    assert.equal(slots.limit, 4);
    assert.ok(slots.tryAcquire({ fusion: 'fusion-x', candidate: 'cand-001' }));
    assert.equal(
      fs.readdirSync(hostSlotsDir(path.join(root, 'worktrees'))).length,
      1
    );
  });
});

test('runFuseCommand: the provider policy refuses a profile before anything starts, naming every refused role', async () => {
  await withStore(async root => {
    fs.writeFileSync(
      path.join(root, '.e', 'config.json'),
      JSON.stringify({ providers: { deny: ['harness:codex'] } })
    );
    const printed: ReportLine[] = [];
    const code = await runFuseCommand(
      'coding',
      ['go'],
      { dir: root },
      refusingDeps(printed)
    );
    assert.equal(code, 1);
    assert.match(
      printed[0].text,
      /refuses fusion profile "coding":\n {2}candidate "codex" sends to harness:codex: denied by "harness:codex"/
    );
    assert.doesNotMatch(printed[0].text, /claudeCode/);
  });
});

test("runFuseCommand: the stages get a redactor for the Store's secrets, and an allowed profile runs", async () => {
  await withStore(async root => {
    fs.writeFileSync(
      path.join(root, '.e', 'config.json'),
      JSON.stringify({
        providers: {
          allow: ['harness:claudeCode', 'harness:codex'],
        },
      })
    );
    fs.writeFileSync(
      path.join(root, '.e', '.env'),
      'GITHUB_TOKEN=ghp_abcdefghij\n'
    );
    let redacted: string | undefined;
    const deps = refusingDeps([]);
    deps.fanOut = async d => {
      redacted = d.redact?.text('token ghp_abcdefghij');
      return fanOut({ state: 'canceled' });
    };
    await runFuseCommand('coding', ['go'], { dir: root }, deps);
    assert.equal(redacted, 'token [redacted:GITHUB_TOKEN]');
  });
});

test("runFuseCommand: the Store's loop caps reach the fan-out, which derives its deadlines from them", async () => {
  await withStore(async root => {
    fs.writeFileSync(
      path.join(root, '.e', 'config.json'),
      JSON.stringify({ loop: { totalTimeoutMs: 600000 } })
    );
    let loop: unknown;
    const printed: ReportLine[] = [];
    const deps = refusingDeps(printed);
    deps.fanOut = async d => {
      loop = d.loop;
      return fanOut({ state: 'canceled' });
    };
    await runFuseCommand('coding', ['go'], { dir: root }, deps);
    assert.equal((loop as { totalTimeoutMs: number }).totalTimeoutMs, 600000);
  });
});

test('fuseCancelHandling: the first signal cancels; later ones wait; only a spent grace kills the children and exits', () => {
  const cancel = new AbortController();
  const warned: string[] = [];
  const exits: number[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const killed: Array<string | undefined> = [];
  const child: ChildHandle = {
    exited: new Promise(() => {}),
    kill: signal => killed.push(signal),
  };
  const onSignal = fuseCancelHandling({
    cancel,
    live: () => [child],
    exit: code => exits.push(code),
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    warn: text => warned.push(text),
  });
  onSignal();
  assert.equal(cancel.signal.aborted, true);
  assert.equal(timers.length, 1);
  // Past every child's own grace, so none is cut short, and past the
  // coordinator's, which kills a stubborn child itself first.
  assert.equal(timers[0].ms, FUSE_CANCEL_GRACE_MS);
  assert.ok(FUSION_KILL_GRACE_MS > CANCEL_GRACE_MS);
  assert.ok(FUSE_CANCEL_GRACE_MS > FUSION_KILL_GRACE_MS);
  // A second Ctrl-C never leaves the children running on their own.
  onSignal();
  assert.equal(timers.length, 1);
  assert.deepEqual(exits, []);
  assert.deepEqual(killed, []);
  assert.match(warned[1], /Still canceling/);
  timers[0].fn();
  assert.deepEqual(killed, ['SIGKILL']);
  assert.deepEqual(exits, [143]);
});

test('fuseEventLines: a synthesis stopped by totalMs reads exhausted, not canceled', () => {
  const [line] = fuseEventLines(
    { kind: 'synthesis-settled', id: 'syn-001', exitCode: 2 },
    {
      name: 'coding',
      synthesizer: 'claudeCode',
      maxConcurrency: 2,
      minUsable: 1,
    }
  );
  assert.match(line.text, /\[synthesis\] syn-001 claudeCode: exhausted/);
});
