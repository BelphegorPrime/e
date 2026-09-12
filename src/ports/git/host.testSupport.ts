import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Real-git test helpers, shared by the HostGit tests and the run tests that
 * drive the orchestrator against real git. Not a test file itself (the
 * `*.test.js` glob skips it).
 */

/** Runs `git -C repo args...`, returning trimmed stdout; throws on a non-zero exit. */
export function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return (result.stdout ?? '').trim();
}

/** A throwaway repo with a test identity and one commit (`base.txt`) on `main`. */
export function initRepo(prefix = 'e-git-test-'): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'e test');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}
