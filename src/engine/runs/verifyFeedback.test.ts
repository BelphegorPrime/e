import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyFeedback } from './verifyFeedback.js';

/*
 * What a fresh container is told about the attempt that just failed
 * (ADR-0016). A suffix, appended after the restated task: the worktree carries
 * the code, the prompt carries the intent, and this carries the verdict.
 */

test('verifyFeedback: names the attempt, the command and its exit code, and shows the output', () => {
  const suffix = verifyFeedback({
    attempt: 3,
    command: 'npm test',
    exitCode: 1,
    output: 'FAIL src/auth.test.ts\n  expected 200, got 401',
  });
  assert.match(suffix, /attempt 3/);
  assert.match(suffix, /npm test/);
  assert.match(suffix, /exited 1/);
  assert.match(suffix, /expected 200, got 401/);
});

test('verifyFeedback: long output is tailed to a byte budget, and says so', () => {
  // Test runners put the actionable summary last, so the tail is what matters.
  const output = 'x'.repeat(20000) + '\nFAIL the one line that matters';
  const suffix = verifyFeedback({
    attempt: 1,
    command: 'npm test',
    exitCode: 1,
    output,
  });
  assert.match(suffix, /FAIL the one line that matters/, 'the tail survives');
  assert.ok(
    Buffer.byteLength(suffix, 'utf8') < 6000,
    `suffix was ${Buffer.byteLength(suffix, 'utf8')} bytes`
  );
  assert.match(suffix, /omitted/, 'truncation is marked, never silent');
});

test('verifyFeedback: output that fits is passed through whole and unmarked', () => {
  const suffix = verifyFeedback({
    attempt: 1,
    command: 'npm test',
    exitCode: 1,
    output: 'one short failure',
  });
  assert.match(suffix, /one short failure/);
  assert.doesNotMatch(suffix, /omitted/);
});

test('verifyFeedback: a multi-byte character is never cut in half', () => {
  const suffix = verifyFeedback({
    attempt: 1,
    command: 'npm test',
    exitCode: 1,
    output: '✗'.repeat(8000),
  });
  assert.doesNotMatch(suffix, /�/, 'no replacement character');
});

test('verifyFeedback: the agent learns the ordinal and never the remaining budget', () => {
  const suffix = verifyFeedback({
    attempt: 2,
    command: 'npm test',
    exitCode: 1,
    output: 'nope',
  });
  assert.match(suffix, /attempt 2/);
  // A countdown buys `.skip`, `|| true` and a deleted test, and because the
  // exit code is the verdict, that hack works. There is no parameter here
  // through which a budget could arrive; this says so out loud.
  assert.doesNotMatch(suffix, /remaining|budget|last attempt|attempts? left/i);
});

test('verifyFeedback: a timed-out check is described as a timeout, not as an exit', () => {
  const suffix = verifyFeedback({
    attempt: 1,
    command: 'npm test',
    exitCode: 124,
    output: 'still running...',
    timedOut: true,
  });
  assert.match(suffix, /timed out/i);
  assert.doesNotMatch(suffix, /exited 124/);
});
