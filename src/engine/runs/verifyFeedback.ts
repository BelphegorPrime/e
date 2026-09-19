/**
 * The **iteration feedback** (ADR-0016): what the next container is told about
 * the attempt that just failed. A fresh container has no conversational
 * memory, so the next prompt restates the task in full and this is appended
 * after it - the worktree carries the code, the prompt carries the intent, and
 * this carries the verdict.
 *
 * Pure, and deliberately narrow: it is handed the attempt ordinal and the
 * check's output, and there is no parameter through which a remaining budget
 * could reach it.
 */

/** The failed attempt this suffix reports. */
export interface VerifyFeedback {
  /** 1-based ordinal of the attempt that just failed. */
  attempt: number;
  /** The check, as declared. */
  command: string;
  /** What it exited with. */
  exitCode: number;
  /** Its combined, interleaved stdout and stderr. */
  output: string;
  /**
   * The check was killed at its wall clock rather than ending on its own. The
   * exit code is then `e`'s statement, not the check's, so saying "exited 124"
   * would describe something that never happened.
   */
  timedOut?: boolean;
}

/**
 * How much of the check's output travels into the next prompt. A **byte**
 * budget rather than a line count, because a line means nothing across tools:
 * one `tsc` line runs to 400 characters, one Jest failure is 40 short ones.
 * A constant, not config, until someone hits it for real.
 */
export const FEEDBACK_BUDGET_BYTES = 4096;

/**
 * The last {@link FEEDBACK_BUDGET_BYTES} of `output`, cut on a UTF-8 character
 * boundary so no multi-byte character arrives halved, with the omission
 * marked - an agent that cannot see it was truncated will reason about the
 * output as if it were whole.
 */
function tail(output: string): string {
  const bytes = Buffer.from(output, 'utf8');
  if (bytes.length <= FEEDBACK_BUDGET_BYTES) return output;
  let start = bytes.length - FEEDBACK_BUDGET_BYTES;
  // Walk forward off any continuation byte (0b10xxxxxx) onto a lead byte.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  const omitted = Math.round(start / 1024);
  return `[... ${omitted}KB omitted ...]\n${bytes.subarray(start).toString('utf8')}`;
}

/** Composes the feedback suffix for the next iteration's prompt. */
export function verifyFeedback(feedback: VerifyFeedback): string {
  return [
    '',
    `## Verify failed (attempt ${feedback.attempt})`,
    '',
    feedback.timedOut
      ? `\`${feedback.command}\` timed out and was stopped.`
      : `\`${feedback.command}\` exited ${feedback.exitCode}.`,
    '',
    '```',
    tail(feedback.output),
    '```',
    '',
    'Fix what it reports. The same command runs again when you finish.',
  ].join('\n');
}
