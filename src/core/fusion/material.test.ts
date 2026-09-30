import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fusionBlockLines,
  materialSummary,
  parseFusionMaterial,
  type FusionMaterial,
} from './material.js';
import type { CandidateResult } from './result.js';

/*
 * The synthesis material's summary (ADR-0019 sections 7, 8): what the
 * synthesis run is told about its candidates, and the one source its PR
 * block is built from - identifiers only, never a candidate's prose.
 */

const FUSION = 'fusion-01K6ZQ4W0R1X2Y3Z4A5B6C7D8E';

function result(over: Partial<CandidateResult>): CandidateResult {
  return {
    schemaVersion: 1,
    fusion: FUSION,
    candidate: 'cand-001',
    agent: 'claude',
    harness: { name: 'claudeCode', version: '2.1.284' },
    provider: null,
    skills: [],
    mcp: [],
    base: { sha: 'abc1234def', branch: 'main' },
    branch: 'e/claude/add-retries-1',
    tip: 'tip1',
    changes: { files: [], added: 0, removed: 0 },
    patch: 'patch.diff',
    patchTruncated: false,
    files: 'files',
    filesTruncated: false,
    outcome: 'succeeded',
    exitCode: 0,
    reason: null,
    attempt: 1,
    retryOf: null,
    startedAt: '2026-09-30T10:00:00.000Z',
    endedAt: '2026-09-30T10:01:00.000Z',
    elapsedMs: 60000,
    usage: null,
    ...over,
  };
}

const summary: FusionMaterial = materialSummary({
  fusion: FUSION,
  profile: 'coding',
  synthesizer: 'claude-reviewer',
  base: { sha: 'abc1234def', branch: 'main' },
  task: 'Add retries with backoff',
  candidates: [
    result({ verify: { verdict: 'green', attempts: 1 } }),
    result({
      candidate: 'cand-002',
      agent: 'codex',
      branch: 'e/codex/add-retries-1',
      outcome: 'failed',
      exitCode: 2,
      reason: 'exhausted:iterations',
      verify: { verdict: 'red', attempts: 3 },
    }),
    result({
      candidate: 'cand-003',
      agent: 'pi-local',
      branch: 'e/pi-local/add-retries-1',
      tip: null,
      outcome: 'empty',
    }),
  ],
  pushed: ['e/claude/add-retries-1', 'e/codex/add-retries-1'],
});

test('materialSummary: every candidate, with its pushed branch only', () => {
  assert.deepEqual(summary.candidates, [
    {
      candidate: 'cand-001',
      agent: 'claude',
      outcome: 'succeeded',
      reason: null,
      verify: 'green',
      branch: 'e/claude/add-retries-1',
      usable: true,
    },
    {
      candidate: 'cand-002',
      agent: 'codex',
      outcome: 'failed',
      reason: 'exhausted:iterations',
      verify: 'red',
      branch: 'e/codex/add-retries-1',
      usable: true,
    },
    {
      // Not pushed: nothing on the remote a PR could point at.
      candidate: 'cand-003',
      agent: 'pi-local',
      outcome: 'empty',
      reason: null,
      verify: null,
      branch: null,
      usable: false,
    },
  ]);
});

test('parseFusionMaterial: a summary reads back as written', () => {
  assert.deepEqual(
    parseFusionMaterial(JSON.parse(JSON.stringify(summary)), 'm.json'),
    summary
  );
});

test('parseFusionMaterial: anything that is not an identifier is refused, because the PR block is rendered', () => {
  const bad = (patch: Record<string, unknown>) => ({ ...summary, ...patch });
  const candidate = (patch: Record<string, unknown>) =>
    bad({ candidates: [{ ...summary.candidates[0], ...patch }] });
  const cases: Array<[string, unknown, RegExp]> = [
    ['not an object', [], /must be a JSON object/],
    ['another version', bad({ schemaVersion: 2 }), /schemaVersion is not 1/],
    ['a fusion id', bad({ fusion: 'x' }), /"fusion"/],
    ['a profile with a space', bad({ profile: 'a b' }), /"profile"/],
    [
      'a synthesizer mention',
      bad({ synthesizer: '@octocat' }),
      /"synthesizer"/,
    ],
    [
      'a base that is no sha',
      bad({ base: { sha: 'HEAD', branch: 'main' } }),
      /"base.sha"/,
    ],
    [
      'a base branch climbing out',
      bad({ base: { sha: 'abc1234', branch: '../x' } }),
      /"base.branch"/,
    ],
    ['an empty task', bad({ task: '  ' }), /"task"/],
    [
      'candidates not a list',
      bad({ candidates: {} }),
      /"candidates" must be an array/,
    ],
    [
      'an agent with markdown',
      candidate({ agent: '**x**' }),
      /candidates\[0\].agent/,
    ],
    [
      'a reason in prose',
      candidate({ reason: 'it broke' }),
      /candidates\[0\].reason/,
    ],
    [
      'a branch that is no run branch',
      candidate({ branch: 'main' }),
      /candidates\[0\].branch/,
    ],
    [
      'an outcome unknown',
      candidate({ outcome: 'great' }),
      /candidates\[0\].outcome/,
    ],
    [
      'a verdict unknown',
      candidate({ verify: 'meh' }),
      /candidates\[0\].verify/,
    ],
    [
      'usable not a boolean',
      candidate({ usable: 'yes' }),
      /candidates\[0\].usable/,
    ],
  ];
  for (const [label, raw, message] of cases) {
    assert.throws(() => parseFusionMaterial(raw, 'm.json'), message, label);
  }
});

test('fusionBlockLines: profile, base, synthesizer and every candidate, identifiers only', () => {
  assert.deepEqual(fusionBlockLines(summary), [
    `Fusion: ${FUSION} · profile coding · base abc1234def (main)`,
    'Synthesizer: claude-reviewer',
    'Candidate cand-001: claude · succeeded · verify green · e/claude/add-retries-1',
    'Candidate cand-002: codex · failed (exhausted:iterations) · verify red · e/codex/add-retries-1',
    'Candidate cand-003: pi-local · empty',
  ]);
});
