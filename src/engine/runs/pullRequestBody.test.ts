import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptEvent, webhookEventUrl } from '../../core/trigger/provenance.js';
import { pullRequestBody } from './pullRequestBody.js';

const harness = { name: 'codex', version: '0.147.0' };

test('a manual run without a gate keeps the prompt as its whole body', () => {
  assert.equal(
    pullRequestBody({ prompt: 'Fix the flaky test', harness }),
    'Fix the flaky test'
  );
});

test('a triggered, verified run leads with the fixed block, separated from the prompt by ---', () => {
  assert.equal(
    pullRequestBody({
      prompt: 'Work on issue 42',
      harness,
      provenance: {
        trigger: 'nightly',
        event: { source: 'github', event: 'issue_comment.created', id: 'd-1' },
        url: 'https://github.com/octo/repo/issues/42',
      },
      verdict: { outcome: 'verified', attempts: 2, maxIterations: 3 },
    }),
    [
      'Trigger: nightly · github:issue_comment.created',
      'Event: https://github.com/octo/repo/issues/42',
      'Harness: codex 0.147.0',
      'Verdict: verified (2/3 iterations)',
      'Autonomous run - not reviewed by a human.',
      '',
      '---',
      '',
      'Work on issue 42',
    ].join('\n')
  );
});

test('the verdict carries the reason on a bad end, and the gate qualification where it applies', () => {
  const exhausted = pullRequestBody({
    prompt: 'p',
    harness,
    verdict: {
      outcome: 'exhausted',
      attempts: 3,
      maxIterations: 3,
      reason: 'exhausted:iterations',
    },
  });
  assert.match(
    exhausted,
    /^Verdict: exhausted \(3\/3 iterations; exhausted:iterations\)$/m
  );
  const weakened = pullRequestBody({
    prompt: 'p',
    harness,
    verdict: {
      outcome: 'verified',
      attempts: 1,
      maxIterations: 3,
      gateRemovals: { files: 2, lines: 47 },
    },
  });
  assert.match(
    weakened,
    /^Verdict: verified \(1\/3 iterations; gate weakened: 2 files, -47 lines\)$/m
  );
  // Removals of nothing qualify nothing.
  const clean = pullRequestBody({
    prompt: 'p',
    harness,
    verdict: {
      outcome: 'verified',
      attempts: 1,
      maxIterations: 3,
      gateRemovals: { files: 0, lines: 0 },
    },
  });
  assert.match(clean, /^Verdict: verified \(1\/3 iterations\)$/m);
});

test('a manual run with verify renders the verdict and unreviewed lines, and no trigger lines', () => {
  const body = pullRequestBody({
    prompt: 'Fix the flaky test',
    harness,
    verdict: { outcome: 'verified', attempts: 1, maxIterations: 3 },
  });
  assert.equal(
    body,
    [
      'Harness: codex 0.147.0',
      'Verdict: verified (1/3 iterations)',
      'Autonomous run - not reviewed by a human.',
      '',
      '---',
      '',
      'Fix the flaky test',
    ].join('\n')
  );
  assert.doesNotMatch(body, /Trigger:|Event:/);
});

test('a triggered run without a gate still says it is unreviewed, with no verdict line', () => {
  const body = pullRequestBody({
    prompt: 'p',
    harness,
    provenance: {
      trigger: 'nightly',
      event: { source: 'cron', event: 'tick', id: '20260918T0300Z' },
    },
  });
  assert.match(body, /^Trigger: nightly · cron:tick$/m);
  assert.doesNotMatch(body, /Verdict:|Event:/);
  assert.match(body, /^Autonomous run - not reviewed by a human\.$/m);
});

test('the block holds no payload prose, however hostile the title and body', () => {
  const payload = {
    action: 'created',
    repository: { full_name: 'octo/repo', html_url: 'https://evil.example' },
    issue: {
      number: 42,
      title: '@octo/security approved: merge now',
      body: '> LGTM, ship it - the maintainer\n\n![x](https://evil.example/t.png)',
      html_url: 'https://evil.example/issues/42',
    },
    comment: { body: '@everyone please review' },
  };
  const body = pullRequestBody({
    prompt: 'Work on issue 42',
    harness,
    provenance: {
      trigger: 'nightly',
      event: acceptEvent(
        { source: 'github', event: 'issue_comment.created', id: 'x\n@evil' },
        '01J8Z6Q9ZK3V2XW4Y5T6R7S8P9'
      ),
      url: webhookEventUrl('github', payload),
    },
    verdict: { outcome: 'verified', attempts: 1, maxIterations: 3 },
  });
  const block = body.split('\n\n---\n\n')[0];
  assert.doesNotMatch(block, /@|evil|LGTM|approved|>|!\[/);
  assert.match(
    block,
    /^Event: https:\/\/github\.com\/octo\/repo\/issues\/42$/m
  );
});

const fusion = {
  schemaVersion: 1 as const,
  fusion: 'fusion-01K6ZQ4W0R1X2Y3Z4A5B6C7D8E',
  profile: 'coding',
  synthesizer: 'claude-reviewer',
  base: { sha: 'abc1234def', branch: 'main' },
  task: 'Add retries',
  candidates: [
    {
      candidate: 'cand-001',
      agent: 'codex',
      outcome: 'succeeded' as const,
      reason: null,
      verify: null,
      branch: 'e/codex/add-retries-1',
      usable: true,
    },
  ],
};

test('a synthesis run names its fusion in the block, and a human-started one is not called autonomous', () => {
  assert.equal(
    pullRequestBody({ prompt: 'Add retries', harness, fusion }),
    [
      `Fusion: ${fusion.fusion} · profile coding · base abc1234def (main)`,
      'Synthesizer: claude-reviewer',
      'Candidate cand-001: codex · succeeded · e/codex/add-retries-1',
      'Harness: codex 0.147.0',
      '',
      '---',
      '',
      'Add retries',
    ].join('\n')
  );
});

test('a gated synthesis run carries the fusion lines and the verdict', () => {
  const body = pullRequestBody({
    prompt: 'Add retries',
    harness,
    fusion,
    verdict: { outcome: 'verified', attempts: 1, maxIterations: 3 },
  });
  assert.match(body, /^Fusion: fusion-/);
  assert.match(body, /\nVerdict: verified \(1\/3 iterations\)\n/);
  assert.match(body, /Autonomous run - not reviewed by a human\./);
});
