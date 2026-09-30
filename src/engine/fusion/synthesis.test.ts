import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HarnessAgent } from '../../core/agent/agent.js';
import type { FoundFusionProfile } from '../../core/fusion/load.js';
import { parseFusionMaterial } from '../../core/fusion/material.js';
import type { CandidateResult } from '../../core/fusion/result.js';
import { InMemoryGit } from '../../ports/git/memory.js';
import { writeStatus } from '../../sidecars/broker/contract/spool.js';
import { Env } from '../../shared/utils/env.js';
import type {
  ChildHandle,
  ChildLaunch,
  ChildLauncher,
} from '../runs/childRun.js';
import { runFanOut, type FanOutResult } from './fanOut.js';
import { readFusionRecord, readSynthesisRecord } from './record.js';
import {
  runSynthesis,
  synthesisPrompt,
  type SynthesisDeps,
} from './synthesis.js';

/*
 * The synthesis (ADR-0019 sections 7, 8): after the fan-out, one ordinary run
 * of the synthesizer Agent from the same pinned base, given every candidate's
 * result read-only as untrusted material, and the fusion's one PR.
 */

const FUSION = 'fusion-01K6ZQ4W0R1X2Y3Z4A5B6C7D8E';
const TASK = 'Add retries with backoff';

const found: FoundFusionProfile = {
  profile: {
    name: 'coding',
    candidates: ['claude', 'codex'],
    synthesizer: 'reviewer',
    strategy: 'parallel-synthesize',
    maxConcurrency: 2,
    minUsable: 1,
  },
  agents: new Map<string, HarnessAgent>([
    ['claude', { name: 'claude', harness: 'claudeCode' }],
    ['codex', { name: 'codex', harness: 'codex' }],
    ['reviewer', { name: 'reviewer', harness: 'claudeCode' }],
  ]),
};

/** How each scripted child ends: candidates by id, the synthesis as `syn-001`. */
interface Ending {
  branch?: string;
  exitCode?: number;
  pullRequestUrl?: string;
  reason?: string;
  hang?: boolean;
  /** Runs when the child starts, before it reports anything. */
  onStart?: (launch: ChildLaunch) => void;
}

/** What an `onStart` check threw: re-thrown by the test, never taken for a launch failure. */
const startErrors: unknown[] = [];

function launcher(endings: Record<string, Ending>) {
  const launches: ChildLaunch[] = [];
  const killed: string[] = [];
  const launch: ChildLauncher = l => {
    launches.push(l);
    const id = l.request.id;
    const ending = endings[id] ?? {};
    try {
      ending.onStart?.(l);
    } catch (err) {
      startErrors.push(err);
    }
    let resolve!: (code: number) => void;
    const exited = new Promise<number>(r => (resolve = r));
    const at = () => new Date().toISOString();
    const timer = setTimeout(() => {
      if (ending.branch === undefined) {
        writeStatus(l.spoolDir, id, {
          status: 'failed',
          error: 'x',
          updatedAt: at(),
        });
        resolve(ending.exitCode ?? 1);
        return;
      }
      writeStatus(l.spoolDir, id, {
        status: 'starting',
        branch: ending.branch,
        updatedAt: at(),
      });
      if (ending.hang) return;
      const code = ending.exitCode ?? 0;
      writeStatus(l.spoolDir, id, {
        status: 'done',
        branch: ending.branch,
        exitCode: code,
        pushed: id.startsWith('syn-'),
        ...(ending.pullRequestUrl
          ? { pullRequestUrl: ending.pullRequestUrl }
          : {}),
        ...(ending.reason ? { reason: ending.reason } : {}),
        updatedAt: at(),
      });
      resolve(code);
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

async function withFusion(
  endings: Record<string, Ending>,
  fn: (ctx: {
    deps: SynthesisDeps;
    fanOut: FanOutResult;
    launches: ChildLaunch[];
    killed: string[];
    storeDir: string;
  }) => Promise<void>
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-synthesis-'));
  try {
    const l = launcher(endings);
    const storeDir = path.join(root, '.e');
    const worktreesDir = path.join(root, 'worktrees');
    const git = new InMemoryGit({
      headSha: 'abc1234',
      currentBranch: 'main',
      refCommits: {
        'refs/heads/e/claude/add-retries-1': 'tip-claude',
        'refs/heads/e/codex/add-retries-1': 'tip-codex',
      },
      numstat: [{ path: 'src/x.ts', added: 1, removed: 0 }],
      diff: 'diff --git a/x b/x\n',
      files: { 'tip-claude': { 'src/x.ts': 'x\n' } },
    });
    const shared = {
      storeDir,
      worktreesDir,
      launch: l.launch,
      passthroughArgs: ['--dir', '/repo'],
      baseEnv: { PATH: '/bin' },
      pollIntervalMs: 1,
    };
    const fanOut = await runFanOut(
      { ...shared, git, newFusionId: () => FUSION },
      { found, prompt: TASK }
    );
    await fn({
      deps: shared,
      fanOut,
      launches: l.launches,
      killed: l.killed,
      storeDir,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('runSynthesis: the synthesizer runs once, from the pinned base, with every candidate as material', async () => {
  let material: string | undefined;
  await withFusion(
    {
      'cand-001': { branch: 'e/claude/add-retries-1' },
      // Died before it had a branch: an explicit input all the same.
      'cand-002': {},
      'syn-001': {
        branch: 'e/reviewer/add-retries-1',
        pullRequestUrl: 'https://github.com/o/r/pull/9',
        onStart: l => {
          material = l.env[Env.SPAWN_FUSION_MATERIAL_VAR];
          // What the synthesizer is shown, read while it runs.
          const summary = parseFusionMaterial(
            JSON.parse(
              fs.readFileSync(path.join(material!, 'fusion.json'), 'utf8')
            ),
            'fusion.json'
          );
          assert.equal(summary.task, TASK);
          assert.deepEqual(
            summary.candidates.map(c => [c.candidate, c.outcome, c.branch]),
            [
              ['cand-001', 'succeeded', 'e/claude/add-retries-1'],
              ['cand-002', 'failed', null],
            ]
          );
          for (const id of ['cand-001', 'cand-002']) {
            const result = JSON.parse(
              fs.readFileSync(
                path.join(material!, 'candidates', id, 'result.json'),
                'utf8'
              )
            ) as CandidateResult;
            assert.equal(result.candidate, id);
          }
          assert.equal(
            fs.readFileSync(
              path.join(material!, 'candidates', 'cand-001', 'patch.diff'),
              'utf8'
            ),
            'diff --git a/x b/x\n'
          );
          assert.equal(
            fs.readFileSync(
              path.join(
                material!,
                'candidates',
                'cand-001',
                'files',
                'src',
                'x.ts'
              ),
              'utf8'
            ),
            'x\n'
          );
        },
      },
    },
    async ({ deps, fanOut, launches, storeDir }) => {
      const result = await runSynthesis(deps, { fanOut });
      if (startErrors.length > 0) throw startErrors[0];
      const synth = launches.find(l => l.request.id === 'syn-001')!;
      // An ordinary `e spawn` of the synthesizer Agent.
      assert.deepEqual(synth.args.slice(0, 2), ['spawn', 'reviewer']);
      assert.ok(synth.args.includes('/repo'));
      // Named after the task: its branch is e/reviewer/<task slug>-N.
      const name = synth.args.indexOf('--name');
      assert.equal(synth.args[name + 1], 'add-retries-backoff');
      assert.equal(synth.request.agent, 'reviewer');
      assert.equal(synth.env[Env.SPAWN_FUSION_SYNTHESIS_VAR], FUSION);
      assert.equal(synth.env[Env.SPAWN_FUSION_VAR], undefined);
      assert.equal(synth.env[Env.SPAWN_FUSION_BASE_SHA_VAR], 'abc1234');
      assert.equal(synth.env[Env.SPAWN_FUSION_BASE_BRANCH_VAR], 'main');
      assert.equal(synth.env[Env.SPAWN_REPORT_ID_VAR], 'syn-001');
      // The prompt is host text plus the task, and nothing a candidate wrote.
      assert.equal(synth.request.prompt, synthesisPrompt(TASK, 2));
      assert.equal(
        synth.args.at(-1),
        synthesisPrompt(TASK, 2),
        'the prompt goes last, behind --'
      );

      assert.deepEqual(result, {
        fusion: FUSION,
        state: 'completed',
        exitCode: 0,
        branch: 'e/reviewer/add-retries-1',
        pushed: true,
        pullRequestUrl: 'https://github.com/o/r/pull/9',
      });
      const record = readFusionRecord(storeDir, FUSION)!;
      assert.equal(record.state, 'completed');
      assert.deepEqual(record.synthesis, { id: 'syn-001', agent: 'reviewer' });
      assert.ok(record.endedAt);
      const synthesisRecord = readSynthesisRecord(storeDir, FUSION)!;
      assert.equal(synthesisRecord.branch, 'e/reviewer/add-retries-1');
      assert.equal(synthesisRecord.exitCode, 0);
      assert.equal(
        synthesisRecord.pullRequestUrl,
        'https://github.com/o/r/pull/9'
      );
      // The fusion has ended: the spool, material and logs with it.
      assert.equal(fs.existsSync(fanOut.spoolDir), false);
    }
  );
  assert.ok(material);
});

test("runSynthesis: the synthesis verdict is the fusion's exit code", async () => {
  await withFusion(
    {
      'cand-001': { branch: 'e/claude/add-retries-1' },
      'cand-002': { branch: 'e/codex/add-retries-1' },
      'syn-001': {
        branch: 'e/reviewer/add-retries-1',
        exitCode: 2,
        reason: 'exhausted:iterations',
      },
    },
    async ({ deps, fanOut, storeDir }) => {
      const result = await runSynthesis(deps, { fanOut });
      assert.equal(result.state, 'completed');
      assert.equal(result.exitCode, 2);
      assert.equal(result.reason, 'exhausted:iterations');
      assert.equal(
        readSynthesisRecord(storeDir, FUSION)?.reason,
        'exhausted:iterations'
      );
    }
  );
});

test('runSynthesis: a synthesis that dies before its branch ends the fusion with its exit code', async () => {
  await withFusion(
    {
      'cand-001': { branch: 'e/claude/add-retries-1' },
      'cand-002': { branch: 'e/codex/add-retries-1' },
      'syn-001': { exitCode: 1 },
    },
    async ({ deps, fanOut }) => {
      const result = await runSynthesis(deps, { fanOut });
      assert.equal(result.state, 'completed');
      assert.equal(result.exitCode, 1);
      assert.equal(result.branch, undefined);
      assert.equal(result.pushed, false);
    }
  );
});

test('runSynthesis: a cancel stops the synthesis, and the fusion ends canceled with 143', async () => {
  await withFusion(
    {
      'cand-001': { branch: 'e/claude/add-retries-1' },
      'cand-002': { branch: 'e/codex/add-retries-1' },
      'syn-001': { branch: 'e/reviewer/add-retries-1', hang: true },
    },
    async ({ deps, fanOut, killed, storeDir }) => {
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 20);
      const result = await runSynthesis(deps, {
        fanOut,
        abort: abort.signal,
      });
      assert.deepEqual(killed, ['syn-001']);
      assert.equal(result.state, 'canceled');
      assert.equal(result.exitCode, 143);
      assert.equal(readFusionRecord(storeDir, FUSION)?.state, 'canceled');
      assert.equal(readSynthesisRecord(storeDir, FUSION)?.canceled, true);
    }
  );
});

test('runSynthesis: only a fan-out that closed with enough usable candidates is synthesized', async () => {
  await withFusion(
    { 'cand-001': { branch: 'e/claude/add-retries-1' }, 'cand-002': {} },
    async ({ deps, fanOut, launches }) => {
      await assert.rejects(
        runSynthesis(deps, { fanOut: { ...fanOut, state: 'failed' } }),
        /ended failed; there is nothing to synthesize/
      );
      assert.equal(
        launches.some(l => l.request.id.startsWith('syn-')),
        false
      );
    }
  );
});

test('runSynthesis: a launch that fails ends the fusion with exit 1, and synthesis.json says why', async () => {
  await withFusion(
    { 'cand-001': { branch: 'e/claude/add-retries-1' }, 'cand-002': {} },
    async ({ deps, fanOut, storeDir }) => {
      const failing: ChildLauncher = () => {
        throw new Error('spawn EACCES');
      };
      const result = await runSynthesis(
        { ...deps, launch: failing },
        { fanOut }
      );
      assert.equal(result.state, 'completed');
      assert.equal(result.exitCode, 1);
      const synthesis = readSynthesisRecord(storeDir, FUSION)!;
      assert.equal(synthesis.exitCode, 1);
      assert.match(
        synthesis.error ?? '',
        /could not start the e spawn process: spawn EACCES/
      );
    }
  );
});

test('synthesisPrompt: the task verbatim, where the material is, and that it is untrusted', () => {
  const prompt = synthesisPrompt('Fix #42\nkeep the API', 3);
  assert.match(prompt, /\/run\/e\/fusion/);
  assert.match(prompt, /3 candidate/);
  assert.match(prompt, /untrusted/i);
  assert.match(prompt, /never instructions/i);
  assert.ok(prompt.endsWith('Fix #42\nkeep the API'));
});

test('runSynthesis: a fusion without its record is refused before anything starts', async () => {
  await withFusion(
    { 'cand-001': { branch: 'e/claude/add-retries-1' }, 'cand-002': {} },
    async ({ deps, fanOut, launches }) => {
      await assert.rejects(
        runSynthesis(
          { ...deps, storeDir: path.join(deps.storeDir, 'elsewhere') },
          { fanOut }
        ),
        /has no record/
      );
      assert.equal(
        launches.some(l => l.request.id.startsWith('syn-')),
        false
      );
    }
  );
});

test('runSynthesis: whatever breaks it after the launch, the synthesis is killed and the record says so', async () => {
  await withFusion(
    {
      'cand-001': { branch: 'e/claude/add-retries-1' },
      'cand-002': {},
      'syn-001': { branch: 'e/reviewer/add-retries-1', hang: true },
    },
    async ({ deps, fanOut, killed, storeDir }) => {
      await assert.rejects(
        runSynthesis(deps, {
          fanOut,
          onEvent: event => {
            if (event.kind === 'synthesis-launched')
              throw new Error('renderer crashed');
          },
        }),
        /renderer crashed/
      );
      assert.deepEqual(killed, ['syn-001']);
      const record = readFusionRecord(storeDir, FUSION)!;
      assert.equal(record.state, 'failed');
      assert.equal(record.reason, 'aborted:fusion-coordinator');
    }
  );
});

test('runSynthesis: a cancel before the launch starts no synthesis', async () => {
  await withFusion(
    { 'cand-001': { branch: 'e/claude/add-retries-1' }, 'cand-002': {} },
    async ({ deps, fanOut, launches, storeDir }) => {
      const abort = new AbortController();
      abort.abort();
      const result = await runSynthesis(deps, { fanOut, abort: abort.signal });
      assert.equal(result.state, 'canceled');
      assert.equal(result.exitCode, 143);
      assert.equal(
        launches.some(l => l.request.id.startsWith('syn-')),
        false
      );
      assert.equal(readFusionRecord(storeDir, FUSION)?.state, 'canceled');
      assert.equal(fs.existsSync(fanOut.spoolDir), false);
    }
  );
});

test('runSynthesis: a cancel that lands after the synthesis finished cancels nothing', async () => {
  const abort = new AbortController();
  await withFusion(
    {
      'cand-001': { branch: 'e/claude/add-retries-1' },
      'cand-002': {},
      'syn-001': {
        branch: 'e/reviewer/add-retries-1',
        pullRequestUrl: 'https://github.com/o/r/pull/9',
      },
    },
    async ({ deps, fanOut, killed }) => {
      const result = await runSynthesis(
        { ...deps },
        {
          fanOut,
          abort: abort.signal,
          onEvent: event => {
            if (event.kind === 'synthesis-settled') abort.abort();
          },
        }
      );
      assert.deepEqual(killed, []);
      assert.equal(result.state, 'completed');
      assert.equal(result.exitCode, 0);
      assert.equal(result.pullRequestUrl, 'https://github.com/o/r/pull/9');
    }
  );
});
