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
