import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANDIDATE_RESULT_VERSION,
  candidateOutcome,
  isCandidateId,
  isFusionId,
  isUsable,
  parseCandidateResult,
  type CandidateResult,
} from './result.js';

/*
 * The Candidate result (ADR-0019 section 5): the provider- and
 * harness-neutral envelope a synthesizer reads. Its reader is strict about
 * the version and lenient about what a later v1 adds, so an envelope written
 * by a newer `e` is still read, and one from a different schema never is.
 */

const where = '.e/runs/fusions/fusion-X/candidates/cand-001/result.json';

const full: CandidateResult = {
  schemaVersion: 1,
  fusion: 'fusion-01K6ZQ4W0R1X2Y3Z4A5B6C7D8E',
  candidate: 'cand-002',
  agent: 'codex',
  harness: { name: 'codex', version: '0.159.0', image: 'e-agent-codex' },
  provider: { protocol: 'openai-responses', model: 'gpt-5.3-codex' },
  skills: ['web-search'],
  mcp: [],
  base: { sha: '3f1c0000', branch: 'main' },
  branch: 'e/codex/add-retry-backoff-4',
  tip: '9a0e0000',
  changes: {
    files: [
      { path: 'src/net/retry.ts', added: 41, removed: 3 },
      { path: 'logo.png', added: null, removed: null },
      { path: 'src/b.ts', from: 'src/a.ts', added: 0, removed: 0 },
    ],
    added: 41,
    removed: 3,
  },
  patch: 'patch.diff',
  patchTruncated: false,
  files: 'files',
  filesTruncated: false,
  outcome: 'succeeded',
  exitCode: 0,
  reason: null,
  verify: { verdict: 'green', attempts: 2 },
  attempt: 1,
  retryOf: null,
  startedAt: '2026-09-30T10:00:03.000Z',
  endedAt: '2026-09-30T10:21:44.000Z',
  elapsedMs: 1301000,
  usage: null,
};

test('parseCandidateResult: a full envelope reads back as written', () => {
  assert.deepEqual(parseCandidateResult(structuredClone(full), where), full);
});

test('parseCandidateResult: missing optional telemetry does not invalidate an envelope', () => {
  const minimal = structuredClone(full) as Partial<CandidateResult>;
  delete minimal.verify;
  delete minimal.usage;
  delete minimal.harness!.image;
  const parsed = parseCandidateResult(minimal, where);
  assert.equal(parsed.verify, undefined);
  assert.equal(parsed.usage, null);
  assert.equal(parsed.harness.image, undefined);
});

test('parseCandidateResult: usage keeps what a harness reported and nothing else', () => {
  const parsed = parseCandidateResult(
    { ...structuredClone(full), usage: { outputTokens: 120 } },
    where
  );
  assert.deepEqual(parsed.usage, { outputTokens: 120 });
});

test('parseCandidateResult: a protocol e does not speak yet is still a readable name', () => {
  const parsed = parseCandidateResult(
    {
      ...structuredClone(full),
      provider: { protocol: 'gemini-generate', model: 'g-3' },
      reason: 'exhausted:iterations',
      retryOf: 'cand-001',
    },
    where
  );
  assert.equal(parsed.provider?.protocol, 'gemini-generate');
  assert.equal(parsed.reason, 'exhausted:iterations');
  assert.equal(parsed.retryOf, 'cand-001');
});

test('parseCandidateResult: a field a later v1 added is ignored, not refused', () => {
  // Adding an optional field is not a new version (ADR-0019 section 5).
  const parsed = parseCandidateResult(
    { ...structuredClone(full), newerField: { x: 1 } },
    where
  );
  assert.equal(
    (parsed as unknown as Record<string, unknown>).newerField,
    undefined
  );
});

test('parseCandidateResult: an unknown version is refused, never guessed at', () => {
  for (const version of [2, 0, '1', undefined]) {
    assert.throws(
      () =>
        parseCandidateResult(
          { ...structuredClone(full), schemaVersion: version },
          where
        ),
      new RegExp(
        `^Error: Invalid candidate result at .*: schemaVersion ${JSON.stringify(version) ?? 'undefined'} is not ${CANDIDATE_RESULT_VERSION}`
      ),
      String(version)
    );
  }
});

test('parseCandidateResult: what it refuses to accept', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['no agent', { agent: undefined }, /"agent" must be a string/],
    ['a bad outcome', { outcome: 'great' }, /unknown outcome "great"/],
    ['a bad fusion id', { fusion: '../x' }, /"fusion" is not a fusion id/],
    [
      'a bad candidate id',
      { candidate: 'x/../y' },
      /"candidate" is not a candidate id/,
    ],
    ['base without a sha', { base: { branch: 'main' } }, /"base.sha"/],
    ['changes not an object', { changes: [] }, /"changes"/],
    [
      'a changed file without a path',
      { changes: { files: [{ added: 1, removed: 0 }], added: 1, removed: 0 } },
      /"changes.files\[0\].path"/,
    ],
    ['a negative elapsed', { elapsedMs: -1 }, /"elapsedMs"/],
    ['an attempt of zero', { attempt: 0 }, /"attempt"/],
    [
      'a verify verdict unknown',
      { verify: { verdict: 'meh', attempts: 1 } },
      /"verify.verdict"/,
    ],
    ['usage with a string', { usage: { costUsd: '3' } }, /"usage.costUsd"/],
    [
      'a reason in prose',
      { reason: 'the image build failed' },
      /"reason" "the image build failed" is not aborted:\* or exhausted:\*/,
    ],
    [
      'a retryOf that is no id',
      { retryOf: '../x' },
      /"retryOf" is not a candidate id/,
    ],
    [
      'not an object',
      [] as unknown as Record<string, unknown>,
      /must be a JSON object/,
    ],
  ];
  for (const [label, patch, message] of cases) {
    const raw = Array.isArray(patch)
      ? patch
      : { ...structuredClone(full), ...patch };
    assert.throws(() => parseCandidateResult(raw, where), message, label);
  }
});

test('candidateOutcome: what a synthesizer must not confuse', () => {
  const cases: Array<[Parameters<typeof candidateOutcome>[0], string]> = [
    [{ exitCode: 0, hasCommits: true }, 'succeeded'],
    // A refusal: all four harnesses exit 0 without writing anything.
    [{ exitCode: 0, hasCommits: false }, 'empty'],
    [{ exitCode: 1, hasCommits: true }, 'failed'],
    [{ exitCode: 2, hasCommits: true }, 'failed'],
    [{ hasCommits: false }, 'failed'],
    // The run's own cancel code, from outside the fusion.
    [{ exitCode: 143, hasCommits: false }, 'canceled'],
    // The fusion's deadline and a human's cancel win over whatever exited.
    [
      { exitCode: 143, stoppedBy: 'candidates-deadline', hasCommits: true },
      'timed-out',
    ],
    [{ exitCode: 0, stoppedBy: 'cancel', hasCommits: true }, 'canceled'],
  ];
  for (const [end, outcome] of cases) {
    assert.equal(candidateOutcome(end), outcome, JSON.stringify(end));
  }
});

test('isUsable: commits beyond the base, whatever the verdict', () => {
  assert.equal(isUsable(full), true);
  assert.equal(isUsable({ ...full, outcome: 'failed' }), true);
  assert.equal(isUsable({ ...full, tip: null, outcome: 'empty' }), false);
});

test('isFusionId / isCandidateId: the ids that may become a path', () => {
  assert.equal(isFusionId('fusion-01K6ZQ4W0R1X2Y3Z4A5B6C7D8E'), true);
  assert.equal(isFusionId('fusion-../../etc'), false);
  assert.equal(isFusionId('trg-01K6ZQ4W0R1X2Y3Z4A5B6C7D8E'), false);
  assert.equal(isCandidateId('cand-001'), true);
  assert.equal(isCandidateId('cand-1'), false);
  assert.equal(isCandidateId('sib-001'), false);
});
