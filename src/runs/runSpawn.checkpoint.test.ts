import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostGit } from '../git/host.js';
import { git, initRepo } from '../git/host.testSupport.js';
import { slugify } from '../identity/slugify.js';
import { runSpawn } from './runSpawn.js';
import {
  FakeRuntime,
  demoAgent,
  demoHarness,
  makeSleep,
} from './runSpawn.testSupport.js';

// The checkpoint of ADR-0013 (ticket 04), end to end against real git: the
// orchestrator with the real `HostGit` and a fake container runtime. HostGit
// resolves the repo from cwd, so the test chdirs into a throwaway repo.

test('end to end: a dirty parent worktree is checkpointed and the sibling starts from that snapshot', async () => {
  const repo = initRepo('e-checkpoint-repo-');
  const worktreesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'e-checkpoint-wt-')
  );
  const originalCwd = process.cwd();
  try {
    process.chdir(repo);
    const host = new HostGit();

    // The parent run's worktree, as its own runSpawn cut it ...
    const parentBranch = 'e/demo/parent-1';
    const parentWorktree = path.join(worktreesDir, 'e', 'demo', 'parent-1');
    host.addWorktree({
      path: parentWorktree,
      branch: parentBranch,
      base: 'main',
    });
    // ... with the parent agent's work in progress, uncommitted.
    fs.writeFileSync(path.join(parentWorktree, 'wip.txt'), 'half done\n');
    fs.appendFileSync(path.join(parentWorktree, 'base.txt'), 'parent edit\n');
    assert.equal(host.isDirty(parentWorktree), true);
    const parentTipBefore = host.headSha(parentWorktree);

    const runtime = new FakeRuntime();
    const prompt = 'Take over the tests';
    const result = await runSpawn(
      { git: host, runtime, sleep: makeSleep(runtime) },
      {
        agent: demoAgent,
        harness: demoHarness,
        prompt,
        imageTag: 'e-harness-demo',
        runOptions: { rm: true },
        worktreesDir,
        keepWorktree: true,
        role: 'child',
        parent: { worktreePath: parentWorktree, branch: parentBranch },
      }
    );
    assert.equal(result.ran, true);

    // Pre-spawn dirty, post-spawn clean: one host checkpoint commit on the
    // parent's own branch, with no agent action.
    assert.equal(host.isDirty(parentWorktree), false);
    const checkpoint = host.headSha(parentWorktree);
    assert.notEqual(checkpoint, parentTipBefore);
    assert.equal(
      git(parentWorktree, 'rev-parse', '--abbrev-ref', 'HEAD'),
      parentBranch
    );
    assert.equal(
      git(parentWorktree, 'log', '-1', '--format=%s'),
      `e: checkpoint ${parentBranch} before spawning ${slugify(prompt)}`
    );
    assert.equal(result.base, checkpoint);

    // The sibling branched from the checkpoint, so the parent's WIP is inside it.
    const siblingBranch = `e/demo/${slugify(prompt)}-1`;
    assert.equal(result.branch, siblingBranch);
    const siblingWorktree = path.join(
      worktreesDir,
      'e',
      'demo',
      `${slugify(prompt)}-1`
    );
    assert.equal(git(siblingWorktree, 'rev-parse', 'HEAD'), checkpoint);
    assert.equal(
      fs.readFileSync(path.join(siblingWorktree, 'wip.txt'), 'utf8'),
      'half done\n'
    );
    assert.equal(
      fs.readFileSync(path.join(siblingWorktree, 'base.txt'), 'utf8'),
      'base\nparent edit\n'
    );
    // The host's own HEAD (main) was not the base and is untouched.
    assert.equal(git(repo, 'rev-parse', 'main'), parentTipBefore);
    // The sibling's container was pointed at the sibling's worktree.
    assert.deepEqual(runtime.options?.volumes?.[0], {
      host: siblingWorktree,
      container: '/workspace',
    });
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(worktreesDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
