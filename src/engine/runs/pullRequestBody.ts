import type { Provenance } from '../../core/trigger/provenance.js';
import { describeGateRemovals, type GateRemovals } from './gateRemovals.js';
import type { LoopOutcome, LoopReason } from './runSpawn.js';

/**
 * **The PR body** (ADR-0016 section 9): the prompt, led by a fixed block for
 * any run a human did not review - a triggered one, or one a gate accepted -
 * and separated from it by `---`.
 *
 * Built from validated identifiers and URLs derived from them, **never payload
 * prose**. A PR body is worse than a prompt in this respect because it is
 * _rendered_: prose there means @-mentions, markdown and quotes that look like
 * someone said them.
 */

/** How a gated run's loop ended, as the block states it. */
export interface PullRequestVerdict {
  outcome: LoopOutcome;
  /** Attempts made. */
  attempts: number;
  /** The attempt budget. */
  maxIterations: number;
  /** Why it ended, stated on a bad end. */
  reason?: LoopReason;
  /** Lines removed under `verify.guards`, which qualify `verified`. */
  gateRemovals?: GateRemovals;
}

export interface PullRequestBodyInput {
  /** The prompt that drove the run. */
  prompt: string;
  /** Present for a triggered run. */
  provenance?: Provenance;
  harness: { name: string; version: string };
  /** Present for a gated run. */
  verdict?: PullRequestVerdict;
}

/** `verified (2/3 iterations)`, qualified by the reason or the weakened gate. */
function verdictLine(verdict: PullRequestVerdict): string {
  // Removals qualify the one word they cast doubt on, and only it (section 11).
  const qualifier =
    verdict.outcome === 'verified'
      ? verdict.gateRemovals && verdict.gateRemovals.files > 0
        ? `gate weakened: ${describeGateRemovals(verdict.gateRemovals)}`
        : undefined
      : verdict.reason;
  const counted = `${verdict.attempts}/${verdict.maxIterations} iterations`;
  return `Verdict: ${verdict.outcome} (${counted}${qualifier ? `; ${qualifier}` : ''})`;
}

/** The body of a run's PR/MR. */
export function pullRequestBody(input: PullRequestBodyInput): string {
  const { provenance, verdict } = input;
  // A manual run nobody gated: a human typed it and will read it.
  if (!provenance && !verdict) return input.prompt;
  const lines: string[] = [];
  if (provenance) {
    lines.push(
      `Trigger: ${provenance.trigger} · ${provenance.event.source}:${provenance.event.event}`
    );
    if (provenance.url) lines.push(`Event: ${provenance.url}`);
  }
  lines.push(`Harness: ${input.harness.name} ${input.harness.version}`);
  if (verdict) lines.push(verdictLine(verdict));
  lines.push('Autonomous run - not reviewed by a human.');
  // The blank line before `---` matters: straight after text it would turn
  // the last line into a heading.
  return `${lines.join('\n')}\n\n---\n\n${input.prompt}`;
}
