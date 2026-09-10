import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostGit } from './host.js';
import { buildRunIndex } from '../runs/runIndex.js';

/** Runs `git -C repo args...`, returning trimmed stdout. */
function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return (result.stdout ?? '').trim();
}

/** A throwaway repo with a couple of run branches and one non-run branch. */
function seedRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'e-host-git-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'e test');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
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
        '  sed -i "s/unformatted/formatted/" new.txt',
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
