import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOOP_CAPS } from '../store/config.js';
import {
  FUSION_DEADLINE_MARGIN_MS,
  classifyAttempt,
  fusionDeadlines,
  retryDelayMs,
  retryPolicy,
} from './budget.js';
import { DEFAULT_FUSION_RETRY } from './profile.js';
import type { CandidateResult } from './result.js';

/*
 * A fusion's budgets (ADR-0019 section 9): deadlines derived so a Run's own
 * caps fire first, a capped exponential backoff with jitter, and the
 * conservative line between a failure worth another attempt and one that is
 * an answer.
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

test('fusionDeadlines: undeclared, each Run gets its full wall clock before the fusion reaches it', () => {
  // Three candidates, two at a time: two rounds of a 3 h Run each.
  assert.deepEqual(
    fusionDeadlines({ candidates: ['a', 'b', 'c'], maxConcurrency: 2 }),
    {
      candidatesMs: 2 * 3 * HOUR + FUSION_DEADLINE_MARGIN_MS,
      totalMs: 2 * 3 * HOUR + 15 * MIN + 3 * HOUR + 15 * MIN,
    }
  );
  // Derived from the Store's loop caps, not the built-in ones.
  assert.deepEqual(
    fusionDeadlines(
      { candidates: ['a', 'b'], maxConcurrency: 2 },
      { totalTimeoutMs: HOUR }
    ),
    { candidatesMs: HOUR + 15 * MIN, totalMs: 2 * HOUR + 30 * MIN }
  );
  assert.equal(DEFAULT_LOOP_CAPS.totalTimeoutMs, 3 * HOUR);
});

test('fusionDeadlines: a declared value is taken as it stands, the other derived around it', () => {
  const candidates = ['a', 'b'];
  assert.deepEqual(
    fusionDeadlines({
      candidates,
      maxConcurrency: 2,
      timeouts: { candidatesMs: 10 * MIN, totalMs: 20 * MIN },
    }),
    { candidatesMs: 10 * MIN, totalMs: 20 * MIN }
  );
  assert.deepEqual(
    fusionDeadlines({
      candidates,
      maxConcurrency: 2,
      timeouts: { candidatesMs: 10 * MIN },
    }),
    { candidatesMs: 10 * MIN, totalMs: 10 * MIN + 3 * HOUR + 15 * MIN }
  );
  // Only the whole declared: the fan-out's derived deadline lies past it,
  // and the hard one bounds both.
  assert.deepEqual(
    fusionDeadlines({
      candidates,
      maxConcurrency: 2,
      timeouts: { totalMs: HOUR },
    }),
    { candidatesMs: 3 * HOUR + 15 * MIN, totalMs: HOUR }
  );
});

test('retryPolicy: no declaration, no retries', () => {
  assert.deepEqual(retryPolicy({}), DEFAULT_FUSION_RETRY);
  assert.equal(retryPolicy({}).maxAttempts, 1);
  const declared = { maxAttempts: 3, backoffMs: 5, maxBackoffMs: 50 };
  assert.deepEqual(retryPolicy({ retry: declared }), declared);
});

test('retryDelayMs: doubles per attempt up to the ceiling, half fixed and half jitter', () => {
  const policy = { backoffMs: 1_000, maxBackoffMs: 5_000 };
  // No jitter drawn: exactly half the capped delay.
  assert.equal(
    retryDelayMs(policy, 1, () => 0),
    500
  );
  assert.equal(
    retryDelayMs(policy, 2, () => 0),
    1_000
  );
  assert.equal(
    retryDelayMs(policy, 3, () => 0),
    2_000
  );
  // The ceiling holds however many attempts came before.
  assert.equal(
    retryDelayMs(policy, 4, () => 0),
    2_500
  );
  assert.equal(
    retryDelayMs(policy, 99, () => 0),
    2_500
  );
  // The whole jitter drawn: the full capped delay.
  assert.equal(
    retryDelayMs(policy, 1, () => 1),
    1_000
  );
  assert.equal(
    retryDelayMs(policy, 2, () => 0.5),
    1_500
  );
  // A source outside [0, 1] is clamped, never a negative or runaway delay.
  assert.equal(
    retryDelayMs(policy, 1, () => -3),
    500
  );
  assert.equal(
    retryDelayMs(policy, 1, () => 7),
    1_000
  );
  const drawn = retryDelayMs(policy, 1);
  assert.ok(drawn >= 500 && drawn <= 1_000);
});

const failed: CandidateResult = {
  schemaVersion: 1,
  fusion: 'fusion-01K6ZQ4W0R1X2Y3Z4A5B6C7D8E',
  candidate: 'cand-001',
  agent: 'codex',
  harness: { name: 'codex', version: '0.159.0' },
  provider: null,
  skills: [],
  mcp: [],
  base: { sha: 'abc1234', branch: 'main' },
  branch: null,
  tip: null,
  changes: { files: [], added: 0, removed: 0 },
  patch: null,
  patchTruncated: false,
  files: null,
  filesTruncated: false,
  outcome: 'failed',
  exitCode: 1,
  reason: null,
  attempt: 1,
  retryOf: null,
  startedAt: '2026-09-30T10:00:00.000Z',
  endedAt: '2026-09-30T10:00:01.000Z',
  elapsedMs: 1000,
  usage: null,
};

test('classifyAttempt: a launch, build or harness failure without commits is retryable', () => {
  assert.equal(classifyAttempt(failed), 'retryable', 'could not launch');
  assert.equal(
    classifyAttempt({ ...failed, branch: 'e/codex/x-1' }),
    'retryable',
    'died after its worktree, before a commit'
  );
  assert.equal(
    classifyAttempt({ ...failed, reason: 'aborted:harness-exit' }),
    'retryable',
    'the harness process died'
  );
});

test('classifyAttempt: commits, a gate verdict, a cap or the fusion itself make it terminal', () => {
  const cases: Array<[string, CandidateResult]> = [
    ['it produced commits', { ...failed, tip: 'tip', patch: 'patch.diff' }],
    [
      'the gate answered',
      { ...failed, verify: { verdict: 'red', attempts: 3 } },
    ],
    ['its iterations ran out', { ...failed, reason: 'exhausted:iterations' }],
    ['it ran out of memory', { ...failed, reason: 'aborted:oom' }],
    ['its check is broken', { ...failed, reason: 'aborted:verify-broken' }],
    [
      'its branch cannot be read',
      { ...failed, reason: 'aborted:collect-failed' },
    ],
    ['it succeeded', { ...failed, outcome: 'succeeded', exitCode: 0 }],
    ['it refused', { ...failed, outcome: 'empty', exitCode: 0 }],
    ['the fan-out timed it out', { ...failed, outcome: 'timed-out' }],
    ['it was canceled', { ...failed, outcome: 'canceled', exitCode: 143 }],
  ];
  for (const [label, result] of cases) {
    assert.equal(classifyAttempt(result), 'terminal', label);
  }
});
