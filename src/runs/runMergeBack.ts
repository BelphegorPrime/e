/**
 * **Merge-back** (ADR-0013, ticket 07): a finished sibling's branch folded
 * into its parent's live worktree by the host, never by anyone inside a
 * container. The parent agent may still be writing, so the sequence is:
 *
 * 1. If a merge-back is already in progress there (a conflict nobody has
 *    concluded), hold: git would refuse, and concluding it is the parent's.
 * 2. Checkpoint the parent's uncommitted work on its own branch
 *    (`Git.commitAll`) - the "fold the parent's WIP" of the ADR. With `--no-ff`
 *    any staged change would make git refuse, so this is the last index write
 *    before the merge (ticket 03).
 * 3. `Git.merge` the sibling's branch as a merge commit. Its files land in the
 *    worktree in place; the agent sees them on its next read.
 *
 * A conflict is left in progress with its markers (never resolved by the host): the
 * parent resolves the files and signals, and {@link concludeMergeBack} commits
 * the resolution. A refusal over files still in flight (edits that landed
 * between the checkpoint and the merge) is held with those files named, for
 * the parent to clear and signal; the host also retries when the parent run
 * ends. Every outcome is written into the sibling's status for `GET /status`
 * and as a report at `e-runs/<id>/report.md` inside the parent worktree, the
 * one place the agent can read without a host path or git.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SPAWN_BROTHER_SCRIPT, runReportPath } from '../broker/constants.js';
import type { MergeBack, SiblingRecord } from '../broker/types.js';
import type { Git } from '../git/index.js';

/** The parent run a sibling merges back into. */
export interface MergeBackParent {
  /** Host path of the parent's worktree (the agent's live `/workspace`). */
  worktreePath: string;
  /** The parent's run branch, named in the checkpoint commit. */
  branch: string;
}

/** The sibling to fold in. */
export interface MergeBackSibling {
  /** The request id (`sib-NNN`), which names the report directory. */
  id: string;
  /** The sibling's run branch. */
  branch: string;
}

/** True when a merge-back put the sibling's work in the parent's tree (or there was none to put). */
export function mergeLanded(merge: MergeBack): boolean {
  return merge.status === 'merged' || merge.status === 'up-to-date';
}

/** Git's message for a second process holding the worktree's index. */
function isLockCollision(message: string): boolean {
  return /index\.lock|Another git process seems to be running/i.test(message);
}

/** The merge commit's subject; one visible node per sibling in the parent's history. */
export function mergeMessage(sibling: MergeBackSibling): string {
  return `e: merge back ${sibling.branch}`;
}

/** The checkpoint commit's subject: the parent's WIP, folded in before the merge. */
export function checkpointMessage(
  parent: MergeBackParent,
  sibling: MergeBackSibling
): string {
  return `e: checkpoint ${parent.branch} before merging ${sibling.branch}`;
}

/**
 * Folds `sibling` into `parent` (see the module doc). Never throws: every way
 * the merge can end is a {@link MergeBack} for the status and the report.
 */
export function mergeBackSibling(
  git: Git,
  parent: MergeBackParent,
  sibling: MergeBackSibling
): MergeBack {
  if (git.mergeInProgress(parent.worktreePath)) {
    return {
      status: 'held',
      files: [],
      reason:
        'another merge-back is still in progress in your worktree (conflict markers to resolve and signal); this one retries once that one is concluded',
    };
  }
  if (git.isDirty(parent.worktreePath)) {
    try {
      git.commitAll(parent.worktreePath, checkpointMessage(parent, sibling));
    } catch (err) {
      return {
        status: 'held',
        files: [],
        reason: `your work could not be checkpointed before the merge: ${(err as Error).message}`,
      };
    }
  }
  let outcome;
  try {
    outcome = git.merge(
      parent.worktreePath,
      sibling.branch,
      mergeMessage(sibling)
    );
  } catch (err) {
    const message = (err as Error).message;
    // The sibling `e spawn` process checkpoints this same worktree (ticket
    // 04); two git processes on one index collide on `index.lock`. Transient:
    // held, retried on the next landing or at the run's end.
    if (isLockCollision(message)) {
      return {
        status: 'held',
        files: [],
        reason: `another git process was using your worktree (${message.trim().split('\n')[0]}); retried when the next merge lands or your run ends`,
      };
    }
    return {
      status: 'failed',
      reason: `git refused to merge ${sibling.branch}: ${message}`,
    };
  }
  switch (outcome.status) {
    case 'merged':
      return { status: 'merged' };
    case 'up-to-date':
      return { status: 'up-to-date' };
    case 'conflict':
      return { status: 'conflict', files: outcome.files };
    case 'refused':
      return {
        status: 'held',
        files: outcome.files,
        reason:
          'your edits to these files were still in flight when the host tried; finish and save them, then signal',
      };
  }
}

/**
 * Concludes a merge-back the parent reported resolved: commits the worktree
 * (the resolution plus whatever else the parent has going, so nothing of its
 * work is left behind the merge) as the merge commit. Nothing in progress any
 * more - the parent run's own commit concluded it, or it was aborted by hand
 * - means merging again tells which: an already-landed merge is up to date,
 * and reported as merged.
 */
export function concludeMergeBack(
  git: Git,
  parent: MergeBackParent,
  sibling: MergeBackSibling,
  previous: MergeBack
): MergeBack {
  if (!git.mergeInProgress(parent.worktreePath)) {
    const again = mergeBackSibling(git, parent, sibling);
    return again.status === 'up-to-date' ? { status: 'merged' } : again;
  }
  try {
    git.commitAll(
      parent.worktreePath,
      `${mergeMessage(sibling)} (conflict resolved in ${parent.branch})`
    );
    return { status: 'merged' };
  } catch (err) {
    return {
      ...previous,
      reason: `the resolution could not be committed: ${(err as Error).message}`,
    };
  }
}

/** The host path of sibling `id`'s report inside `parentWorktree`. */
export function reportFileFor(parentWorktree: string, id: string): string {
  return path.join(parentWorktree, ...runReportPath(id).split('/'));
}

const MARKERS = '`<<<<<<<` / `=======` / `>>>>>>>`';

/** The paragraph telling the parent agent what a merge-back state means and what to do. */
function explain(record: SiblingRecord, merge: MergeBack): string[] {
  const signal = `node <skill dir>/${SPAWN_BROTHER_SCRIPT} --merge ${record.id}`;
  const files = (merge.files ?? []).map(file => `- \`${file}\``);
  switch (merge.status) {
    case 'merged':
      return [
        "The sibling's branch was merged into your worktree as a merge commit. Its",
        'files are in place: re-read any you had open. Your own uncommitted work was',
        'checkpointed first; nothing of yours was lost.',
      ];
    case 'up-to-date':
      return [
        "The sibling's branch added no commits beyond your checkpoint: nothing to merge.",
      ];
    case 'conflict':
      return [
        'The merge is in progress with conflict markers in:',
        '',
        ...files,
        '',
        'Resolve each file by editing it (keep what is right, remove the',
        `${MARKERS} markers; never run git), then signal:`,
        '',
        '```bash',
        signal,
        '```',
        '',
        'The host concludes the merge as a commit that also carries your current',
        'work. Until then no other sibling can be merged. The host never resolves a',
        'conflict for you; if your run ends first, it commits what it finds.',
      ];
    case 'held':
      return [
        'The merge was not started - ' + (merge.reason ?? 'held') + '.',
        ...(files.length > 0 ? ['', 'Files in the way:', '', ...files] : []),
        '',
        'When they are clear, signal so the host checkpoints your work and retries:',
        '',
        '```bash',
        signal,
        '```',
        '',
        'The host also retries when your run ends with exit code 0.',
      ];
    case 'skipped':
    case 'failed':
      return [
        `Not merged: ${merge.reason ?? merge.status}.`,
        ...(record.branch
          ? [`Its branch \`${record.branch}\` keeps whatever it committed.`]
          : []),
      ];
  }
}

/** Renders the report the parent agent reads (pure). */
export function renderSiblingReport(
  record: SiblingRecord,
  merge: MergeBack
): string {
  const lines = [
    `# Sibling ${record.id}: ${merge.status}`,
    '',
    `- agent: ${record.agent}`,
    ...(record.branch ? [`- branch: ${record.branch}`] : []),
    `- run: ${record.status}${record.exitCode !== undefined ? `, exit code ${record.exitCode}` : ''}`,
    ...(record.error ? [`- error: ${record.error}`] : []),
    `- merge: ${merge.status}`,
    `- taskState: ${record.taskState}`,
    `- task: ${record.prompt.replace(/\s+/g, ' ').trim()}`,
    '',
    ...explain(record, merge),
    // A remote A2A agent's answer (ADR-0015): the report is the only place it lands.
    ...(record.answer !== undefined
      ? ['', '## Answer', '', record.answer.trimEnd()]
      : []),
  ];
  return lines.join('\n') + '\n';
}

/**
 * Writes sibling `record`'s report into the parent worktree at
 * `e-runs/<id>/report.md` (atomically, so the agent never reads half of it)
 * and returns the worktree-relative path the status carries. The file is
 * the agent's, committed with the run like everything else in the worktree.
 */
export function writeSiblingReport(
  parentWorktree: string,
  record: SiblingRecord,
  merge: MergeBack
): string {
  const file = reportFileFor(parentWorktree, record.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, renderSiblingReport(record, merge));
  fs.renameSync(tmp, file);
  return runReportPath(record.id);
}
