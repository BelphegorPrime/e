import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostGit } from './host.js';
import { git, initRepo } from './host.testSupport.js';
import { buildRunIndex } from '../runs/runIndex.js';

/** A throwaway repo with a couple of run branches and one non-run branch. */
function seedRepo(): string {
  const repo = initRepo('e-host-git-');
  git(repo, 'branch', 'e/claudeCode/fix-typos-2');
  git(repo, 'checkout', '-q', 'e/claudeCode/fix-typos-2');
  fs.writeFileSync(path.join(repo, 'typos.txt'), 'typos');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fix: typo in parser');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'branch', 'e/cheapCodex/spawn-helper-1');
  git(repo, 'branch', 'feature/unrelated');
  return repo;
}

test('HostGit.listRunRefs finds run branches under the e/ namespace', () => {
  const repo = seedRepo();
  const originalCwd = process.cwd();
  try {
    process.chdir(repo);
    const refs = new HostGit().listRunRefs('e');
    const names = refs.map(ref => ref.name);
    assert.ok(names.includes('e/claudeCode/fix-typos-2'));
    assert.ok(names.includes('e/cheapCodex/spawn-helper-1'));
    assert.ok(!names.includes('feature/unrelated'));
    // NUL parsing put the subject in the right column.
    const typos = refs.find(ref => ref.name === 'e/claudeCode/fix-typos-2')!;
    assert.equal(typos.subject, 'fix: typo in parser');
    assert.match(typos.sha, /^[0-9a-f]{40}$/);
    assert.ok(!Number.isNaN(Date.parse(typos.committerDate)));
    // No duplicates when the same ref matches both enumerated glob shapes.
    assert.equal(refs.length, new Set(names).size);
    // The index built from real git output carries the right metadata.
    const runs = buildRunIndex(refs);
    const entry = runs.find(run => run.branch === 'e/claudeCode/fix-typos-2')!;
    assert.equal(entry.agent, 'claudeCode');
    assert.equal(entry.slug, 'fix-typos');
    assert.equal(entry.counter, 2);
    assert.equal(entry.local, true);
    assert.equal(entry.subject, 'fix: typo in parser');
    // runLog parses the NUL-separated columns (`%H%x00%s%x00%cI`).
    const commits = new HostGit().runLog('e/claudeCode/fix-typos-2');
    assert.equal(commits.length, 2);
    assert.equal(commits[0]!.subject, 'fix: typo in parser');
    assert.match(commits[0]!.sha, /^[0-9a-f]{40}$/);
    assert.ok(!Number.isNaN(Date.parse(commits[0]!.committerDate)));
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.isRepo is true inside a repo and false in a plain directory', () => {
  const repo = seedRepo();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'e-host-plain-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(repo);
    assert.equal(new HostGit().isRepo(), true);
    process.chdir(plain);
    assert.equal(new HostGit().isRepo(), false);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('HostGit.headSha resolves the current commit', () => {
  const repo = seedRepo();
  const originalCwd = process.cwd();
  try {
    process.chdir(repo);
    const sha = new HostGit().headSha();
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(sha, git(repo, 'rev-parse', 'HEAD'));
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.currentBranch is the branch name, empty on a detached HEAD', () => {
  const repo = seedRepo();
  const originalCwd = process.cwd();
  try {
    process.chdir(repo);
    assert.equal(new HostGit().currentBranch(), 'main');
    git(repo, 'checkout', '-q', '--detach');
    assert.equal(new HostGit().currentBranch(), '');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.listRunBranches matches flat run-branch names and nothing else', () => {
  const repo = seedRepo();
  const originalCwd = process.cwd();
  try {
    // Create a flat run branch that matches refs/heads/e-*
    git(repo, 'branch', 'e-run-3');
    process.chdir(repo);
    const branches = new HostGit().listRunBranches('e');
    assert.ok(branches.includes('e-run-3'));
    // Nested branches do NOT match the flat e-* glob
    assert.ok(!branches.includes('e/claudeCode/fix-typos-2'));
    assert.ok(!branches.includes('feature/unrelated'));
    assert.ok(!branches.includes('main'));
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.branchExists resolves local branches and misses unknown ones', () => {
  const repo = seedRepo();
  const originalCwd = process.cwd();
  try {
    process.chdir(repo);
    const host = new HostGit();
    assert.equal(host.branchExists('main'), true);
    assert.equal(host.branchExists('e/cheapCodex/spawn-helper-1'), true);
    assert.equal(host.branchExists('no/such-branch'), false);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.isDirty reports a clean worktree as clean and a modified one as dirty', () => {
  const repo = seedRepo();
  const originalCwd = process.cwd();
  try {
    process.chdir(repo);
    const host = new HostGit();
    assert.equal(host.isDirty(repo), false);
    fs.appendFileSync(path.join(repo, 'base.txt'), '\ndirty');
    assert.equal(host.isDirty(repo), true);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.commitAll stages and commits every change in the worktree', () => {
  const repo = seedRepo();
  const originalCwd = process.cwd();
  try {
    process.chdir(repo);
    const host = new HostGit();
    fs.writeFileSync(path.join(repo, 'new.txt'), 'added');
    assert.equal(host.isDirty(repo), true);
    host.commitAll(repo, 'test: add new.txt');
    assert.equal(host.isDirty(repo), false);
    assert.match(git(repo, 'log', '-1', '--format=%s'), /test: add new.txt/);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.commitAll retries once when a pre-commit hook rewrites the staged files', () => {
  const repo = seedRepo();
  const originalCwd = process.cwd();
  try {
    process.chdir(repo);
    // Simulates prettier --write: rewrites the file and fails the first
    // attempt so a human reviews the diff; the second attempt (files
    // already fixed) has nothing left to change and passes.
    fs.writeFileSync(
      path.join(repo, '.git', 'hooks', 'pre-commit'),
      [
        '#!/bin/sh',
        'if grep -q unformatted new.txt 2>/dev/null; then',
        // Not `sed -i`: GNU and BSD sed disagree on its argument shape.
        '  sed "s/unformatted/formatted/" new.txt > new.txt.tmp',
        '  mv new.txt.tmp new.txt',
        '  git add -A',
        '  exit 1',
        'fi',
        'exit 0',
        '',
      ].join('\n')
    );
    fs.chmodSync(path.join(repo, '.git', 'hooks', 'pre-commit'), 0o755);

    const host = new HostGit();
    fs.writeFileSync(path.join(repo, 'new.txt'), 'unformatted');
    host.commitAll(repo, 'test: add new.txt');

    assert.equal(host.isDirty(repo), false);
    assert.equal(
      fs.readFileSync(path.join(repo, 'new.txt'), 'utf8'),
      'formatted'
    );
    assert.match(git(repo, 'log', '-1', '--format=%s'), /test: add new.txt/);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.commitAll rethrows when the hook still fails on the retry, leaving changes staged', () => {
  const repo = seedRepo();
  const originalCwd = process.cwd();
  try {
    process.chdir(repo);
    fs.writeFileSync(
      path.join(repo, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\nexit 1\n'
    );
    fs.chmodSync(path.join(repo, '.git', 'hooks', 'pre-commit'), 0o755);

    const host = new HostGit();
    fs.writeFileSync(path.join(repo, 'new.txt'), 'added');
    assert.throws(() => host.commitAll(repo, 'test: add new.txt'));
    // The failed commit must not have discarded the staged work.
    assert.equal(host.isDirty(repo), true);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.hasCommitsBeyondBase counts the run branch beyond its base', () => {
  const repo = seedRepo();
  const originalCwd = process.cwd();
  try {
    process.chdir(repo);
    const host = new HostGit();
    assert.equal(
      host.hasCommitsBeyondBase('e/claudeCode/fix-typos-2', 'main'),
      true
    );
    assert.equal(host.hasCommitsBeyondBase('main', 'main'), false);
    assert.equal(
      host.hasCommitsBeyondBase('main', 'e/claudeCode/fix-typos-2'),
      false
    );
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.addWorktree creates the branch and the path; a live branch is refused', () => {
  const repo = seedRepo();
  const originalCwd = process.cwd();
  const wt = path.join(repo, '..', 'e-adder-wt');
  try {
    process.chdir(repo);
    const host = new HostGit();
    host.addWorktree({ branch: 'e/agent/adder-1', path: wt, base: 'main' });
    assert.equal(host.branchExists('e/agent/adder-1'), true);
    assert.ok(fs.existsSync(wt));
    // A duplicate branch must refuse (atomic-create guarantee), not silently overwrite.
    assert.throws(() =>
      host.addWorktree({ branch: 'e/agent/adder-1', path: wt, base: 'main' })
    );
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(wt, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.removeWorktree removes the path and leaves the branch', () => {
  const repo = seedRepo();
  const originalCwd = process.cwd();
  const wt = path.join(repo, '..', 'e-remover-wt');
  try {
    process.chdir(repo);
    const host = new HostGit();
    host.addWorktree({ branch: 'e/agent/remover-1', path: wt, base: 'main' });
    assert.ok(fs.existsSync(wt));
    host.removeWorktree(wt);
    assert.ok(!fs.existsSync(wt));
    assert.equal(host.branchExists('e/agent/remover-1'), true);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(wt, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.push sends the branch to a bare origin', () => {
  const repo = seedRepo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'e-host-remote-'));
  const originalCwd = process.cwd();
  try {
    git(remote, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', remote);
    process.chdir(repo);
    new HostGit().push('main');
    const remoteBranches = git(remote, 'branch');
    assert.match(remoteBranches, /\*? ?main/);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('HostGit.listRunRefs with a full prefix only matches its own branches', () => {
  const repo = seedRepo();
  const originalCwd = process.cwd();
  try {
    process.chdir(repo);
    const refs = new HostGit().listRunRefs('e/cheapCodex/spawn-helper');
    const names = refs.map(ref => ref.name);
    assert.ok(names.includes('e/cheapCodex/spawn-helper-1'));
    assert.ok(!names.includes('e/claudeCode/fix-typos-2'));
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// `merge` operates on a worktree by path (`-C`), never on cwd, so these tests
// need no chdir. Each seeds a repo, cuts a worktree for the "parent" branch,
// and cuts a "sibling" branch to merge in.
function seedMergeRepo(): { repo: string; worktree: string } {
  const repo = seedRepo();
  const worktree = path.join(repo, 'wt-parent');
  git(repo, 'worktree', 'add', '-q', '-b', 'e/demo/parent-1', worktree, 'main');
  return { repo, worktree };
}

/** Cuts `branch` from `base` (default `main`) with one commit writing `files`. */
function cutBranch(
  repo: string,
  branch: string,
  opts: { files: Record<string, string>; message: string; base?: string }
): void {
  const tmp = path.join(repo, `wt-${branch.replace(/\//g, '-')}`);
  git(repo, 'worktree', 'add', '-q', '-b', branch, tmp, opts.base ?? 'main');
  for (const [file, content] of Object.entries(opts.files)) {
    fs.writeFileSync(path.join(tmp, file), content);
  }
  git(tmp, 'add', '-A');
  git(tmp, 'commit', '-q', '-m', opts.message);
  git(repo, 'worktree', 'remove', '--force', tmp);
}

/** True while `MERGE_HEAD` resolves in the worktree (`git()` would throw on the miss). */
function mergeInProgress(worktree: string): boolean {
  return (
    spawnSync('git', [
      '-C',
      worktree,
      'rev-parse',
      '-q',
      '--verify',
      'MERGE_HEAD',
    ]).status === 0
  );
}

const sibling = 'e/demo/sibling-1';

test('HostGit.merge lands a sibling branch as a merge commit and reports merged', () => {
  const { repo, worktree } = seedMergeRepo();
  try {
    cutBranch(repo, sibling, {
      files: { 'sibling.txt': 'from sibling' },
      message: 'sibling work',
    });
    const before = git(worktree, 'rev-parse', 'HEAD');

    const outcome = new HostGit().merge(worktree, sibling, 'merge sibling');

    assert.deepEqual(outcome, { status: 'merged' });
    assert.equal(
      fs.readFileSync(path.join(worktree, 'sibling.txt'), 'utf8'),
      'from sibling'
    );
    // A merge commit, not a fast-forward, with the message we asked for.
    assert.notEqual(git(worktree, 'rev-parse', 'HEAD'), before);
    assert.equal(git(worktree, 'rev-list', '--merges', '--count', 'HEAD'), '1');
    assert.equal(git(worktree, 'log', '-1', '--format=%s'), 'merge sibling');
    // Nothing left in progress; the worktree is clean.
    assert.equal(new HostGit().isDirty(worktree), false);
    assert.equal(mergeInProgress(worktree), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.merge without a message still commits (git default subject)', () => {
  const { repo, worktree } = seedMergeRepo();
  try {
    cutBranch(repo, sibling, {
      files: { 'sibling.txt': 'x' },
      message: 'sibling work',
    });
    assert.deepEqual(new HostGit().merge(worktree, sibling), {
      status: 'merged',
    });
    assert.match(
      git(worktree, 'log', '-1', '--format=%s'),
      /^Merge branch 'e\/demo\/sibling-1'/
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.merge of an already-reachable branch is up-to-date and changes nothing', () => {
  const { repo, worktree } = seedMergeRepo();
  try {
    const before = git(worktree, 'rev-parse', 'HEAD');
    // `main` is the parent branch's base, so it is already reachable.
    assert.deepEqual(new HostGit().merge(worktree, 'main'), {
      status: 'up-to-date',
    });
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), before);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.merge leaves a conflict in progress with markers, reporting every file verbatim', () => {
  const { repo, worktree } = seedMergeRepo();
  try {
    // Parent and sibling both rewrite base.txt from the same base, and both
    // add a new file under the same non-ASCII name (an add/add conflict; the
    // name must come back unquoted despite core.quotePath).
    fs.writeFileSync(path.join(worktree, 'base.txt'), 'parent version\n');
    fs.writeFileSync(path.join(worktree, 'ä.txt'), 'parent ä\n');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'parent edit');
    cutBranch(repo, sibling, {
      files: { 'base.txt': 'sibling version\n', 'ä.txt': 'sibling ä\n' },
      message: 'sibling edit',
    });
    const before = git(worktree, 'rev-parse', 'HEAD');

    const outcome = new HostGit().merge(worktree, sibling);

    assert.deepEqual(outcome, {
      status: 'conflict',
      files: ['base.txt', 'ä.txt'],
    });
    const content = fs.readFileSync(path.join(worktree, 'base.txt'), 'utf8');
    assert.match(content, /^<<<<<<< /m);
    assert.match(content, /parent version/);
    assert.match(content, /sibling version/);
    assert.match(content, /^>>>>>>> /m);
    // Not aborted, not auto-resolved: MERGE_HEAD is set and HEAD unchanged.
    assert.equal(mergeInProgress(worktree), true);
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), before);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.merge refuses while a previous merge is still in progress, leaving it intact', () => {
  const { repo, worktree } = seedMergeRepo();
  try {
    fs.writeFileSync(path.join(worktree, 'base.txt'), 'parent version\n');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'parent edit');
    cutBranch(repo, sibling, {
      files: { 'base.txt': 'sibling version\n' },
      message: 'sibling edit',
    });
    cutBranch(repo, 'e/demo/sibling-2', {
      files: { 'other.txt': 'two\n' },
      message: 'other',
    });
    const host = new HostGit();
    assert.equal(host.merge(worktree, sibling).status, 'conflict');
    const mergeHead = git(worktree, 'rev-parse', 'MERGE_HEAD');

    // The stale conflict must not be reported under the second branch's name.
    assert.throws(
      () => host.merge(worktree, 'e/demo/sibling-2'),
      /git failed \(merge e\/demo\/sibling-2 into .*\): a merge is already in progress/
    );
    assert.equal(git(worktree, 'rev-parse', 'MERGE_HEAD'), mergeHead);
    assert.match(
      fs.readFileSync(path.join(worktree, 'base.txt'), 'utf8'),
      /^<<<<<<< /m
    );
    assert.equal(fs.existsSync(path.join(worktree, 'other.txt')), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.merge throws, touching nothing, when local changes would be overwritten', () => {
  const { repo, worktree } = seedMergeRepo();
  try {
    cutBranch(repo, sibling, {
      files: { 'base.txt': 'sibling version\n' },
      message: 'sibling edit',
    });
    // Uncommitted parent edit to the very file the merge would rewrite.
    fs.writeFileSync(
      path.join(worktree, 'base.txt'),
      'uncommitted parent edit\n'
    );
    const before = git(worktree, 'rev-parse', 'HEAD');

    assert.throws(
      () => new HostGit().merge(worktree, sibling),
      /git failed \(merge e\/demo\/sibling-1 into .*\): .*(overwritten|Please commit)/s
    );
    assert.equal(
      fs.readFileSync(path.join(worktree, 'base.txt'), 'utf8'),
      'uncommitted parent edit\n'
    );
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), before);
    assert.equal(mergeInProgress(worktree), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.merge (--no-ff) also refuses a staged change in an unrelated file', () => {
  const { repo, worktree } = seedMergeRepo();
  try {
    cutBranch(repo, sibling, {
      files: { 'sibling.txt': 'x' },
      message: 'sibling work',
    });
    // Staged but uncommitted, in a file the merge never touches: a
    // fast-forward would tolerate it, the merge commit does not. Ticket 07's
    // checkpoint must therefore be the last index write before a merge-back.
    fs.writeFileSync(path.join(worktree, 'unrelated.txt'), 'staged\n');
    git(worktree, 'add', 'unrelated.txt');

    assert.throws(
      () => new HostGit().merge(worktree, sibling),
      /git failed \(merge/
    );
    assert.equal(mergeInProgress(worktree), false);
    assert.equal(fs.existsSync(path.join(worktree, 'sibling.txt')), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.merge throws, not "conflict", when a pre-merge-commit hook stops the merge', () => {
  const { repo, worktree } = seedMergeRepo();
  try {
    cutBranch(repo, sibling, {
      files: { 'sibling.txt': 'x' },
      message: 'sibling work',
    });
    const hook = path.join(repo, '.git', 'hooks', 'pre-merge-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    // Files merged, commit refused: MERGE_HEAD is set but nothing is unmerged,
    // so this is a failure to report, not a conflict for the agent to resolve.
    assert.throws(
      () => new HostGit().merge(worktree, sibling),
      /git failed \(merge e\/demo\/sibling-1/
    );
    assert.equal(mergeInProgress(worktree), true);
    assert.equal(git(worktree, 'diff', '--name-only', '--diff-filter=U'), '');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.merge throws for a branch that does not exist', () => {
  const { repo, worktree } = seedMergeRepo();
  try {
    assert.throws(
      () => new HostGit().merge(worktree, 'e/demo/nope-9'),
      /git failed \(merge e\/demo\/nope-9 into .*\)/
    );
    assert.equal(mergeInProgress(worktree), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostGit.headSha(worktreePath) resolves that worktree, not the repo it was called from', () => {
  const { repo, worktree } = seedMergeRepo();
  try {
    fs.writeFileSync(path.join(worktree, 'wip.txt'), 'x');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'in the worktree');
    const host = new HostGit();
    assert.equal(host.headSha(worktree), git(worktree, 'rev-parse', 'HEAD'));
    assert.notEqual(host.headSha(worktree), git(repo, 'rev-parse', 'main'));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
