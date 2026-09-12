import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HostGit } from '../git/host.js';
import { git, initRepo } from '../git/host.testSupport.js';
import type { Git, MergeOutcome } from '../git/index.js';
import type { SiblingRecord } from '../broker/types.js';
import {
  checkpointMessage,
  concludeMergeBack,
  mergeBackSibling,
  mergeMessage,
  renderSiblingReport,
  reportFileFor,
  writeSiblingReport,
} from './runMergeBack.js';

// The merge-back against real git: a repo, the parent's worktree on its run
// branch, and sibling branches cut from it with one commit each. `HostGit`
// takes every path explicitly here, so no chdir is needed.

const parent = { worktreePath: '', branch: 'e/demo/parent-1' };

function seed(): {
  repo: string;
  parent: { worktreePath: string; branch: string };
} {
  const repo = initRepo('e-merge-back-');
  const worktreePath = path.join(repo, 'wt-parent');
  git(repo, 'worktree', 'add', '-q', '-b', parent.branch, worktreePath, 'main');
  return { repo, parent: { ...parent, worktreePath } };
}

/** Cuts `branch` from the parent's current tip with one commit writing `files`. */
function cutSibling(
  repo: string,
  from: string,
  branch: string,
  files: Record<string, string>
): void {
  const tmp = path.join(repo, `wt-${branch.replace(/\//g, '-')}`);
  git(repo, 'worktree', 'add', '-q', '-b', branch, tmp, from);
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(tmp, file), content);
  }
  git(tmp, 'add', '-A');
  git(tmp, 'commit', '-q', '-m', `work on ${branch}`);
  git(repo, 'worktree', 'remove', '--force', tmp);
}

const subjects = (worktree: string) =>
  git(worktree, 'log', '--format=%s').split('\n');

test('a clean parent: the sibling lands as one merge commit and its files appear in the worktree', () => {
  const { repo, parent } = seed();
  try {
    const host = new HostGit();
    const sibling = { id: 'sib-001', branch: 'e/researcher/look-1' };
    cutSibling(repo, parent.branch, sibling.branch, { 'found.txt': 'x\n' });

    assert.deepEqual(mergeBackSibling(host, parent, sibling), {
      status: 'merged',
    });
    assert.equal(
      fs.readFileSync(path.join(parent.worktreePath, 'found.txt'), 'utf8'),
      'x\n'
    );
    assert.equal(subjects(parent.worktreePath)[0], mergeMessage(sibling));
    assert.equal(
      git(parent.worktreePath, 'rev-list', '--merges', '--count', 'HEAD'),
      '1'
    );
    assert.equal(host.isDirty(parent.worktreePath), false);
    assert.equal(host.mergeInProgress(parent.worktreePath), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a dirty parent: its WIP is checkpointed on its own branch first, then the sibling merges; both are in the tree (the ADR's fold)", () => {
  const { repo, parent } = seed();
  try {
    const host = new HostGit();
    const sibling = { id: 'sib-001', branch: 'e/researcher/look-1' };
    cutSibling(repo, parent.branch, sibling.branch, {
      'base.txt': 'sibling edit\n',
    });
    // The parent agent kept working after the sibling was cut: a new file and
    // an edit to a file the sibling does not touch.
    fs.writeFileSync(path.join(parent.worktreePath, 'wip.txt'), 'half\n');

    assert.deepEqual(mergeBackSibling(host, parent, sibling), {
      status: 'merged',
    });
    assert.deepEqual(subjects(parent.worktreePath).slice(0, 2), [
      mergeMessage(sibling),
      checkpointMessage(parent, sibling),
    ]);
    assert.equal(
      fs.readFileSync(path.join(parent.worktreePath, 'wip.txt'), 'utf8'),
      'half\n'
    );
    assert.equal(
      fs.readFileSync(path.join(parent.worktreePath, 'base.txt'), 'utf8'),
      'sibling edit\n'
    );
    assert.equal(host.isDirty(parent.worktreePath), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a conflict stays in progress with markers, holds the next sibling, and concludes on the parent's resolution; the held one then merges", () => {
  const { repo, parent } = seed();
  try {
    const host = new HostGit();
    const first = { id: 'sib-001', branch: 'e/researcher/look-1' };
    const second = { id: 'sib-002', branch: 'e/researcher/look-2' };
    cutSibling(repo, parent.branch, first.branch, {
      'base.txt': 'sibling version\n',
    });
    cutSibling(repo, parent.branch, second.branch, { 'other.txt': 'o\n' });
    // The parent edited the same lines meanwhile (checkpointed by the merge).
    fs.writeFileSync(
      path.join(parent.worktreePath, 'base.txt'),
      'parent version\n'
    );

    const conflict = mergeBackSibling(host, parent, first);
    assert.deepEqual(conflict, { status: 'conflict', files: ['base.txt'] });
    const marked = fs.readFileSync(
      path.join(parent.worktreePath, 'base.txt'),
      'utf8'
    );
    assert.match(marked, /^<<<<<<< /m);
    assert.match(marked, /^>>>>>>> /m);
    assert.equal(host.mergeInProgress(parent.worktreePath), true);

    // Another sibling finishing now cannot be merged: held, not attempted.
    const held = mergeBackSibling(host, parent, second);
    assert.equal(held.status, 'held');
    assert.match(held.reason ?? '', /another merge-back is still in progress/);
    assert.equal(host.mergeInProgress(parent.worktreePath), true);

    // The parent resolves the file by hand and signals; the host concludes.
    fs.writeFileSync(
      path.join(parent.worktreePath, 'base.txt'),
      'both versions\n'
    );
    assert.deepEqual(concludeMergeBack(host, parent, first, conflict), {
      status: 'merged',
    });
    assert.equal(host.mergeInProgress(parent.worktreePath), false);
    assert.equal(
      subjects(parent.worktreePath)[0],
      `${mergeMessage(first)} (conflict resolved in ${parent.branch})`
    );
    assert.equal(
      git(parent.worktreePath, 'log', '-1', '--format=%P').split(' ').length,
      2
    );
    // Concluding again is harmless: the merge commit is already there.
    assert.deepEqual(
      concludeMergeBack(host, parent, first, { status: 'conflict' }),
      { status: 'merged' }
    );

    assert.deepEqual(mergeBackSibling(host, parent, second), {
      status: 'merged',
    });
    assert.equal(
      fs.readFileSync(path.join(parent.worktreePath, 'other.txt'), 'utf8'),
      'o\n'
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a sibling whose branch adds nothing is up-to-date', () => {
  const { repo, parent } = seed();
  try {
    const sibling = { id: 'sib-001', branch: 'e/researcher/idle-1' };
    git(repo, 'branch', sibling.branch, parent.branch);
    assert.deepEqual(mergeBackSibling(new HostGit(), parent, sibling), {
      status: 'up-to-date',
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

/** A `Git` scripted for the paths real git is hard to stage: refusals and failures. */
class ScriptedGit implements Git {
  commits: string[] = [];
  merges: string[] = [];
  constructor(
    private readonly script: {
      dirty?: boolean;
      merging?: boolean;
      merge?: MergeOutcome | Error;
      commitFails?: string;
    }
  ) {}
  isRepo() {
    return true;
  }
  headSha() {
    return 'sha';
  }
  currentBranch() {
    return 'main';
  }
  listRunBranches() {
    return [];
  }
  listRunRefs() {
    return [];
  }
  runLog() {
    return [];
  }
  branchExists() {
    return true;
  }
  addWorktree() {}
  isDirty() {
    return this.script.dirty ?? false;
  }
  commitAll(_path: string, message: string) {
    if (this.script.commitFails) throw new Error(this.script.commitFails);
    this.commits.push(message);
  }
  hasCommitsBeyondBase() {
    return true;
  }
  push() {}
  removeWorktree() {}
  merge(_path: string, branch: string): MergeOutcome {
    this.merges.push(branch);
    const outcome = this.script.merge ?? { status: 'merged' };
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
  mergeInProgress() {
    return this.script.merging ?? false;
  }
}

const sib = { id: 'sib-001', branch: 'e/researcher/look-1' };

test('a refusal over files in flight is held with those files named, for the parent to clear', () => {
  const scripted = new ScriptedGit({
    merge: { status: 'refused', files: ['src/a.ts', 'src/b.ts'] },
  });
  const merge = mergeBackSibling(scripted, parent, sib);
  assert.equal(merge.status, 'held');
  assert.deepEqual(merge.files, ['src/a.ts', 'src/b.ts']);
  assert.match(merge.reason ?? '', /in flight/);
});

test('a checkpoint that cannot be committed holds the merge before git is asked to merge anything', () => {
  const scripted = new ScriptedGit({ dirty: true, commitFails: 'hook failed' });
  const merge = mergeBackSibling(scripted, parent, sib);
  assert.equal(merge.status, 'held');
  assert.match(merge.reason ?? '', /could not be checkpointed.*hook failed/);
  assert.deepEqual(scripted.merges, []);
});

test('any other git refusal is failed with the reason; a resolution that cannot be committed keeps the conflict', () => {
  const scripted = new ScriptedGit({ merge: new Error('unknown ref') });
  assert.deepEqual(mergeBackSibling(scripted, parent, sib), {
    status: 'failed',
    reason: 'git refused to merge e/researcher/look-1: unknown ref',
  });
  const stuck = new ScriptedGit({ merging: true, commitFails: 'hook' });
  const kept = concludeMergeBack(stuck, parent, sib, {
    status: 'conflict',
    files: ['x'],
  });
  assert.equal(kept.status, 'conflict');
  assert.deepEqual(kept.files, ['x']);
  assert.match(kept.reason ?? '', /could not be committed: hook/);
});

const record = (over: Partial<SiblingRecord> = {}): SiblingRecord => ({
  id: 'sib-001',
  agent: 'researcher',
  prompt: 'look into   X\nand Y',
  requestedAt: 't',
  status: 'done',
  taskState: 'completed',
  branch: 'e/researcher/look-1',
  exitCode: 0,
  ...over,
});

test('the report names the sibling, its branch, task and merge state, and tells the parent what to do', () => {
  const merged = renderSiblingReport(record(), { status: 'merged' });
  assert.match(merged, /^# Sibling sib-001: merged$/m);
  assert.match(merged, /^- branch: e\/researcher\/look-1$/m);
  assert.match(merged, /^- run: done, exit code 0$/m);
  assert.match(merged, /^- task: look into X and Y$/m);
  assert.match(merged, /re-read any you had open/);

  const conflict = renderSiblingReport(record(), {
    status: 'conflict',
    files: ['src/a.ts', 'docs/b.md'],
  });
  assert.match(conflict, /conflict markers in:/);
  assert.match(conflict, /^- `src\/a\.ts`$/m);
  assert.match(conflict, /^- `docs\/b\.md`$/m);
  assert.match(conflict, /spawn-brother\.mjs --merge sib-001/);
  assert.match(conflict, /never resolves a\s+conflict for you/);

  const held = renderSiblingReport(record(), {
    status: 'held',
    files: ['src/a.ts'],
    reason: 'in flight',
  });
  assert.match(held, /not started - in flight/);
  assert.match(held, /Files in the way:/);
  assert.match(held, /--merge sib-001/);
  assert.match(held, /also retries when your run ends/);

  const skipped = renderSiblingReport(
    record({ status: 'failed', exitCode: 3, error: 'gave up' }),
    { status: 'skipped', reason: 'the sibling failed: gave up' }
  );
  assert.match(skipped, /^# Sibling sib-001: skipped$/m);
  assert.match(skipped, /^- run: failed, exit code 3$/m);
  assert.match(skipped, /^- error: gave up$/m);
  assert.match(skipped, /Not merged: the sibling failed: gave up\./);
  assert.match(skipped, /branch `e\/researcher\/look-1` keeps/);
});

test('writeSiblingReport puts the report at e-runs/<id>/report.md inside the parent worktree and returns that relative path', () => {
  const { repo, parent } = seed();
  try {
    const relative = writeSiblingReport(parent.worktreePath, record(), {
      status: 'merged',
    });
    assert.equal(relative, 'e-runs/sib-001/report.md');
    const file = reportFileFor(parent.worktreePath, 'sib-001');
    assert.equal(
      file,
      path.join(parent.worktreePath, 'e-runs', 'sib-001', 'report.md')
    );
    assert.match(fs.readFileSync(file, 'utf8'), /^# Sibling sib-001: merged/);
    // Overwritten in place on a retry; no temp file left behind.
    writeSiblingReport(parent.worktreePath, record(), { status: 'up-to-date' });
    assert.match(fs.readFileSync(file, 'utf8'), /up-to-date/);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['report.md']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
