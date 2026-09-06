import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostPullRequest } from './host.js';
import { HostGit } from '../git/host.js';

/** Runs `git -C repo args...`, returning trimmed stdout. */
function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return (result.stdout ?? '').trim();
}

/** A throwaway repo on branch `feature/alpha`, committed and checked out. */
function seedRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'e-host-pr-'));
  git(repo, 'init', '-q', '-b', 'feature/alpha');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'e test');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

/**
 * Stub `gh`/`glab` binaries on PATH: each appends its full argv to a shared
 * log file (path from `E_STUB_LOG`) and prints a fake PR/MR URL. Lets the real
 * `HostPullRequest` run end-to-end against a faked platform CLI and assert the
 * exact invocation the orchestrator would make.
 */
function stubCli(urls: { gh: string; glab: string }): {
  log: string;
  restore: () => void;
} {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'e-host-cli-'));
  const log = path.join(bin, 'calls.log');
  const script = (url: string): string => `#!/bin/sh
for a in "$@"; do printf '%s\\0' "$a"; done >> "$E_STUB_LOG"
echo "${url}"
`;
  fs.writeFileSync(path.join(bin, 'gh'), script(urls.gh));
  fs.writeFileSync(path.join(bin, 'glab'), script(urls.glab));
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  fs.chmodSync(path.join(bin, 'glab'), 0o755);
  const originalPath = process.env.PATH;
  const originalStubLog = process.env.E_STUB_LOG;
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.E_STUB_LOG = log;
  return {
    log,
    restore: () => {
      process.env.PATH = originalPath;
      if (originalStubLog === undefined) delete process.env.E_STUB_LOG;
      else process.env.E_STUB_LOG = originalStubLog;
      fs.rmSync(bin, { recursive: true, force: true });
    },
  };
}

test('HostGit.currentBranch: reports the checked-out branch', () => {
  const repo = seedRepo();
  const originalCwd = process.cwd();
  try {
    process.chdir(repo);
    assert.equal(new HostGit().currentBranch(), 'feature/alpha');
    // A detached HEAD is reported as empty, not as the literal "HEAD".
    git(repo, 'checkout', '-q', '--detach', 'HEAD');
    assert.equal(new HostGit().currentBranch(), '');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('HostPullRequest: GitHub uses gh with --head/--base and returns the URL', () => {
  const stub = stubCli({ gh: 'https://github.com/acme/app/pull/7', glab: '' });
  try {
    const url = new HostPullRequest().create({
      platform: 'github',
      head: 'e/pi/fix-1',
      base: 'main',
      title: 'fix: typo in parser',
      body: 'Fix the typo in the parser.',
    });
    assert.equal(url, 'https://github.com/acme/app/pull/7');
    const calls = fs
      .readFileSync(stub.log, 'utf8')
      .trim()
      .split('\0')
      .filter(Boolean);
    assert.deepEqual(calls, [
      'pr',
      'create',
      '--head',
      'e/pi/fix-1',
      '--base',
      'main',
      '--title',
      'fix: typo in parser',
      '--body',
      'Fix the typo in the parser.',
    ]);
  } finally {
    stub.restore();
  }
});

test('HostPullRequest: GitLab uses glab with --source-branch/--target-branch', () => {
  const stub = stubCli({
    gh: '',
    glab: 'https://gitlab.com/acme/app/-/merge_requests/3',
  });
  try {
    const url = new HostPullRequest().create({
      platform: 'gitlab',
      head: 'e/pi/fix-1',
      base: 'main',
      title: 'fix: typo in parser',
      body: 'Fix the typo in the parser.',
    });
    assert.equal(url, 'https://gitlab.com/acme/app/-/merge_requests/3');
    const calls = fs
      .readFileSync(stub.log, 'utf8')
      .trim()
      .split('\0')
      .filter(Boolean);
    assert.deepEqual(calls, [
      'mr',
      'create',
      '--source-branch',
      'e/pi/fix-1',
      '--target-branch',
      'main',
      '--title',
      'fix: typo in parser',
      '--description',
      'Fix the typo in the parser.',
    ]);
  } finally {
    stub.restore();
  }
});

test('HostPullRequest: Forgejo routes through plain gh (host resolved from remote)', () => {
  const stub = stubCli({ gh: 'https://codeberg.org/acme/app/pulls/9', glab: '' });
  try {
    const url = new HostPullRequest().create({
      platform: 'forgejo',
      head: 'e/pi/fix-1',
      base: 'main',
      title: 'fix: typo in parser',
      body: 'Fix the typo in the parser.',
    });
    assert.equal(url, 'https://codeberg.org/acme/app/pulls/9');
    const call = fs
      .readFileSync(stub.log, 'utf8')
      .split('\0')
      .filter(Boolean);
    // Identical argv to a GitHub PR: gh finds the host from the git remote.
    assert.deepEqual(call, [
      'pr',
      'create',
      '--head',
      'e/pi/fix-1',
      '--base',
      'main',
      '--title',
      'fix: typo in parser',
      '--body',
      'Fix the typo in the parser.',
    ]);
  } finally {
    stub.restore();
  }
});

test('HostPullRequest: a failing CLI throws with the platform detail', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'e-host-cli-'));
  fs.writeFileSync(
    path.join(bin, 'gh'),
    '#!/bin/sh\necho "not authenticated" >&2\nexit 1\n'
  );
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  try {
    assert.throws(
      () =>
        new HostPullRequest().create({
          platform: 'github',
          head: 'e/pi/fix-1',
          base: 'main',
          title: 'fix: typo',
          body: 'Fix the typos.',
        }),
      /not authenticated/
    );
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});