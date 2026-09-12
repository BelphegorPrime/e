import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HostGit } from '../git/host.js';
import { git, initRepo } from '../git/host.testSupport.js';
import { createBrokerApi } from '../broker/api.js';
import { readStatus } from '../broker/spool.js';
import type {
  MergeSignalAccepted,
  SiblingStatusPatch,
  SpawnAccepted,
} from '../broker/types.js';
import { slugify } from '../identity/slugify.js';
import type { RunOptions } from '../runtime/index.js';
import { Env } from '../utils/env.js';
import { defaultBrokerPlan } from './runBroker.js';
import type { SiblingLauncher } from './runSiblings.js';
import { runSpawn } from './runSpawn.js';
import {
  FakeRuntime,
  demoAgent,
  demoHarness,
  seedParentArtifacts,
} from './runSpawn.testSupport.js';

// The whole sibling cycle of ADR-0013 end to end (ticket 08), with the real
// pieces the host owns and fakes only where a container would be: a real git
// repo and `HostGit`; the real broker HTTP handler over the spool the parent
// run creates; and siblings that run the real `runSpawn` pipeline in-process
// (what the `e spawn` child process does with the sibling markers) against
// the same git. The container runtimes are fakes whose `onRun` plays each
// agent: the parent asks the broker for siblings and keeps editing, a child
// observes its environment and asks for a sibling of its own (depth two), and
// every finished sibling is merged back into the parent's live worktree -
// cleanly, and once through a conflict the parent resolves and signals.

const until = async (cond: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
};

const post = async (url: string, body?: unknown): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    ...(body !== undefined
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });

test("e2e: a parent spawns children through the real broker; a child spawns a sibling; every branch merges back into the parent worktree, a conflict via the parent's signal", async () => {
  const repo = initRepo('e-e2e-repo-');
  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-e2e-wt-'));
  const originalCwd = process.cwd();
  // The repo ignores what must never travel; the parent's checkpoints sweep
  // everything else (ticket 04).
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n.env\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'ignore artifacts and secrets');
  process.chdir(repo);
  const host = new HostGit();

  const parentPrompt = 'Ship the feature';
  const parentSlug = slugify(parentPrompt);
  const parentRunName = `e-demo-${parentSlug}-1`;
  const spool = path.join(worktreesDir, '.broker', parentRunName);
  const parentWorktree = path.join(
    worktreesDir,
    'e',
    'demo',
    `${parentSlug}-1`
  );
  // The siblings' branches, named from their prompts like any run's.
  const lookBranch = `e/researcher/${slugify('Look into X')}-1`;
  const docsBranch = `e/researcher/${slugify('Write the docs')}-1`;
  const rewriteBranch = `e/researcher/${slugify('Rewrite the base')}-1`;
  const breakBranch = `e/researcher/${slugify('Break the base')}-1`;
  const status = (id: string): SiblingStatusPatch | undefined =>
    readStatus(spool, id);

  // The runtime-broker's HTTP surface, over the spool the parent run creates.
  const server = http.createServer(createBrokerApi({ spoolDir: spool }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const brokerUrl = `http://127.0.0.1:${address.port}`;

  // Real timers, short: the consumer's poll loop must yield to the HTTP I/O.
  const sleep = (ms: number) =>
    new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 2)));

  const children: {
    id: string;
    options: RunOptions;
    command: string[];
    env: Record<string, string | undefined>;
  }[] = [];
  let grandchild: SpawnAccepted | undefined;

  // The sibling launcher: the child `e spawn` pipeline, in-process, from the
  // markers the consumer hands it - checkpoint, branch, artifact sync, run,
  // capture, status - against the same real git.
  const launch: SiblingLauncher = l => {
    const env = l.env;
    const runtime = new FakeRuntime();
    runtime.onRun = async options => {
      const worktree = options.volumes![0].host;
      children.push({
        id: l.request.id,
        options,
        command: runtime.command!,
        env,
      });
      switch (l.request.id) {
        case 'sib-001': {
          fs.writeFileSync(
            path.join(worktree, 'from-sibling.txt'),
            'sibling work\n'
          );
          // Depth two: a child asks its parent's broker for a sibling of its own.
          const res = await post(`${brokerUrl}/spawn`, {
            agent: 'researcher',
            prompt: 'Write the docs',
          });
          assert.equal(res.status, 202);
          grandchild = (await res.json()) as SpawnAccepted;
          break;
        }
        case 'sib-002':
          fs.writeFileSync(path.join(worktree, 'docs.md'), 'docs\n');
          break;
        case 'sib-003':
          // Waits for the parent to edit the same file after the checkpoint,
          // so the merge-back must conflict (the parent signals with a file).
          await until(
            () =>
              fs.existsSync(path.join(parentWorktree, 'parent-edited.flag')),
            "the parent's post-checkpoint edit"
          );
          fs.writeFileSync(
            path.join(worktree, 'base.txt'),
            'sibling version\n'
          );
          break;
        case 'sib-004':
          await until(
            () =>
              fs.existsSync(
                path.join(parentWorktree, 'parent-edited-again.flag')
              ),
            "the parent's second post-checkpoint edit"
          );
          fs.writeFileSync(
            path.join(worktree, 'base.txt'),
            'sibling version 2\n'
          );
          break;
      }
    };
    const exited = runSpawn(
      { git: host, runtime, sleep },
      {
        agent: { name: l.request.agent, harness: 'demo' },
        harness: demoHarness,
        prompt: l.request.prompt,
        imageTag: 'e-harness-demo',
        runOptions: { rm: true },
        worktreesDir,
        keepWorktree: true,
        role: 'child',
        parent: {
          worktreePath: env[Env.SPAWN_PARENT_WORKTREE_VAR]!,
          branch: env[Env.SPAWN_PARENT_BRANCH_VAR]!,
          artifacts: ['node_modules', '.env'],
        },
        sibling: {
          spoolDir: env[Env.SPAWN_SPOOL_VAR]!,
          id: env[Env.SPAWN_SIBLING_ID_VAR]!,
        },
      }
    ).then(
      result => result.exitCode,
      () => 1
    );
    return { exited, kill: () => {} };
  };

  const parentRuntime = new FakeRuntime();
  const seenWhileRunning: Record<string, unknown> = {};
  parentRuntime.onRun = async options => {
    const worktree = options.volumes![0].host;
    assert.equal(worktree, parentWorktree);
    // Work in progress before asking for help - it travels into the sibling
    // through the checkpoint - plus artifacts and a secret that never do.
    fs.writeFileSync(path.join(worktree, 'parent-wip.txt'), 'half done\n');
    seedParentArtifacts(worktree);

    const first = await post(`${brokerUrl}/spawn`, {
      agent: 'researcher',
      prompt: 'Look into X',
    });
    assert.equal(first.status, 202);
    assert.equal(((await first.json()) as SpawnAccepted).id, 'sib-001');
    // The parent keeps working on its own file while the siblings run.
    fs.appendFileSync(path.join(worktree, 'parent-wip.txt'), 'more\n');

    await until(
      () =>
        status('sib-001')?.merge !== undefined &&
        status('sib-002')?.merge !== undefined,
      'both siblings to be merged back'
    );
    // The merged files are in the live worktree while the agent still runs,
    // and its own WIP is untouched.
    seenWhileRunning.fromSibling = fs.readFileSync(
      path.join(worktree, 'from-sibling.txt'),
      'utf8'
    );
    seenWhileRunning.docs = fs.readFileSync(
      path.join(worktree, 'docs.md'),
      'utf8'
    );
    seenWhileRunning.wip = fs.readFileSync(
      path.join(worktree, 'parent-wip.txt'),
      'utf8'
    );
    seenWhileRunning.report1 = fs.readFileSync(
      path.join(worktree, 'e-runs', 'sib-001', 'report.md'),
      'utf8'
    );
    seenWhileRunning.status1 = status('sib-001');
    seenWhileRunning.status2 = status('sib-002');

    // The conflict path: the parent edits a file, spawns, then edits the same
    // file again after the checkpoint while the sibling rewrites it too.
    fs.writeFileSync(path.join(worktree, 'base.txt'), 'parent version 1\n');
    const third = await post(`${brokerUrl}/spawn`, {
      agent: 'researcher',
      prompt: 'Rewrite the base',
    });
    assert.equal(((await third.json()) as SpawnAccepted).id, 'sib-003');
    await until(
      () => status('sib-003')?.status === 'running',
      'sib-003 to run'
    );
    fs.writeFileSync(path.join(worktree, 'base.txt'), 'parent version 2\n');
    fs.writeFileSync(path.join(worktree, 'parent-edited.flag'), '');
    await until(
      () => status('sib-003')?.merge !== undefined,
      'sib-003 to be merged back'
    );
    seenWhileRunning.conflict = status('sib-003');
    seenWhileRunning.marked = fs.readFileSync(
      path.join(worktree, 'base.txt'),
      'utf8'
    );
    seenWhileRunning.report3 = fs.readFileSync(
      path.join(worktree, 'e-runs', 'sib-003', 'report.md'),
      'utf8'
    );
    seenWhileRunning.inProgress = host.mergeInProgress(worktree);

    // The agent resolves the markers and signals through the broker.
    fs.writeFileSync(
      path.join(worktree, 'base.txt'),
      'resolved: both versions\n'
    );
    const signal = await post(`${brokerUrl}/merge/sib-003`);
    assert.equal(signal.status, 202);
    assert.deepEqual((await signal.json()) as MergeSignalAccepted, {
      id: 'sib-003',
      status: 'merge-requested',
      statusPath: '/status/sib-003',
    });
    await until(
      () => status('sib-003')?.merge?.status === 'merged',
      'sib-003 to conclude'
    );
    seenWhileRunning.concluded = host.mergeInProgress(worktree);
    seenWhileRunning.resolvedBase = fs.readFileSync(
      path.join(worktree, 'base.txt'),
      'utf8'
    );
    seenWhileRunning.resolvedReport = fs.readFileSync(
      path.join(worktree, 'e-runs', 'sib-003', 'report.md'),
      'utf8'
    );

    // A second conflict the agent leaves unresolved when it exits: the run's
    // own output commit concludes it, markers and all, and says so.
    fs.writeFileSync(path.join(worktree, 'base.txt'), 'parent version 3\n');
    const fourth = await post(`${brokerUrl}/spawn`, {
      agent: 'researcher',
      prompt: 'Break the base',
    });
    assert.equal(((await fourth.json()) as SpawnAccepted).id, 'sib-004');
    await until(
      () => status('sib-004')?.status === 'running',
      'sib-004 to run'
    );
    fs.writeFileSync(path.join(worktree, 'base.txt'), 'parent version 4\n');
    fs.writeFileSync(path.join(worktree, 'parent-edited-again.flag'), '');
    await until(
      () => status('sib-004')?.merge !== undefined,
      'sib-004 to be merged back'
    );
    assert.equal(status('sib-004')?.merge?.status, 'conflict');
  };

  try {
    const result = await runSpawn(
      { git: host, runtime: parentRuntime, sleep },
      {
        agent: demoAgent,
        harness: demoHarness,
        prompt: parentPrompt,
        imageTag: 'e-harness-demo',
        runOptions: { rm: true },
        worktreesDir,
        keepWorktree: true,
        broker: defaultBrokerPlan(),
        readiness: { attempts: 3, intervalMs: 1 },
        siblingHost: { launch, readiness: { attempts: 5000, intervalMs: 1 } },
      }
    );
    assert.equal(result.ran, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.branch, `e/demo/${parentSlug}-1`);

    // --- While the parent ran: the clean merge-backs.
    assert.equal(seenWhileRunning.fromSibling, 'sibling work\n');
    assert.equal(seenWhileRunning.docs, 'docs\n');
    assert.equal(seenWhileRunning.wip, 'half done\nmore\n');
    assert.match(
      seenWhileRunning.report1 as string,
      /^# Sibling sib-001: merged/
    );
    const status1 = seenWhileRunning.status1 as SiblingStatusPatch;
    assert.equal(status1.status, 'done');
    assert.equal(status1.branch, lookBranch);
    assert.deepEqual(status1.merge, { status: 'merged' });
    assert.equal(status1.report, 'e-runs/sib-001/report.md');
    assert.deepEqual((seenWhileRunning.status2 as SiblingStatusPatch).merge, {
      status: 'merged',
    });

    // --- The conflict: held in progress with markers, never resolved by the
    // host, concluded on the parent's signal with the parent's resolution.
    const conflict = seenWhileRunning.conflict as SiblingStatusPatch;
    assert.deepEqual(conflict.merge, {
      status: 'conflict',
      files: ['base.txt'],
    });
    assert.match(seenWhileRunning.marked as string, /^<<<<<<< /m);
    assert.match(seenWhileRunning.marked as string, /sibling version/);
    assert.match(seenWhileRunning.marked as string, /parent version 2/);
    assert.equal(seenWhileRunning.inProgress, true);
    assert.match(seenWhileRunning.report3 as string, /conflict markers in:/);
    assert.match(
      seenWhileRunning.report3 as string,
      /spawn-brother\.mjs --merge sib-003/
    );
    assert.equal(seenWhileRunning.concluded, false);
    assert.match(
      seenWhileRunning.resolvedReport as string,
      /^# Sibling sib-003: merged/
    );
    assert.equal(seenWhileRunning.resolvedBase, 'resolved: both versions\n');

    // --- The conflict left open at exit: the output commit concluded it with
    // the markers in place (visible, never chosen by the host), the status
    // and report say so, and the rewritten report was committed too.
    const left = status('sib-004');
    assert.equal(left?.merge?.status, 'merged');
    assert.match(left?.merge?.reason ?? '', /leftover conflict markers/);
    const committedBase = fs.readFileSync(
      path.join(parentWorktree, 'base.txt'),
      'utf8'
    );
    assert.match(committedBase, /^<<<<<<< /m);
    assert.match(committedBase, /sibling version 2/);
    assert.match(
      fs.readFileSync(
        path.join(parentWorktree, 'e-runs', 'sib-004', 'report.md'),
        'utf8'
      ),
      /^# Sibling sib-004: merged/
    );

    // --- Depth two, never three: the child's request became a sibling of the
    // parent (the next id in the parent's spool), ran, and merged like any.
    assert.deepEqual(grandchild, {
      id: 'sib-002',
      status: 'requested',
      statusPath: '/status/sib-002',
    });
    assert.deepEqual(
      children.map(c => c.id),
      ['sib-001', 'sib-002', 'sib-003', 'sib-004']
    );
    // No child got a broker sidecar or a spool of its own: their requests
    // can only reach the parent's, which is what makes depth three impossible.
    assert.deepEqual(fs.readdirSync(path.join(worktreesDir, '.broker')), [
      parentRunName,
    ]);
    for (const child of children) {
      assert.equal(child.options.networks, undefined);
      // Each child saw the sibling markers of this parent ...
      assert.equal(child.env[Env.SPAWN_ROLE_VAR], 'child');
      assert.equal(child.env[Env.SPAWN_PARENT_WORKTREE_VAR], parentWorktree);
      assert.equal(
        child.env[Env.SPAWN_PARENT_BRANCH_VAR],
        `e/demo/${parentSlug}-1`
      );
      assert.equal(child.env[Env.SPAWN_SPOOL_VAR], spool);
      // ... and its container was told it is a child.
      assert.match(child.command.join(' '), /Your role in this run is "child"/);
    }

    // --- What never reaches a child: the parent's node_modules arrive as a
    // scratch copy mounted beside the worktree, `.env` and `.git` do not.
    const [firstChild] = children;
    const childWorktree = firstChild.options.volumes![0].host;
    const artifactsCopy = path.join(
      worktreesDir,
      '.artifacts',
      lookBranch.replace(/\//g, '-')
    );
    assert.deepEqual(firstChild.options.volumes, [
      { host: childWorktree, container: '/workspace' },
      {
        host: path.join(artifactsCopy, 'node_modules'),
        container: '/workspace/node_modules',
      },
    ]);
    assert.equal(fs.existsSync(path.join(artifactsCopy, '.env')), false);
    assert.equal(
      fs.existsSync(path.join(artifactsCopy, 'node_modules', 'pkg', '.env')),
      false
    );
    assert.equal(
      fs.existsSync(path.join(artifactsCopy, 'node_modules', '.git')),
      false
    );
    assert.equal(fs.existsSync(path.join(childWorktree, '.env')), false);
    assert.equal(
      fs.existsSync(path.join(childWorktree, 'node_modules')),
      false
    );
    // A worktree's `.git` is a pointer file to the host repo, not the metadata.
    assert.equal(fs.statSync(path.join(childWorktree, '.git')).isFile(), true);
    // The sibling started from the checkpoint: the parent's WIP was in it.
    assert.equal(
      fs.readFileSync(path.join(childWorktree, 'parent-wip.txt'), 'utf8'),
      'half done\n'
    );

    // --- The run's end: every sibling accounted for, three merge commits on
    // the parent branch, the worktree clean and kept.
    assert.deepEqual(
      (result.siblings ?? []).map(s => [
        s.id,
        s.branch,
        s.merge.status,
        s.report,
      ]),
      [
        ['sib-001', lookBranch, 'merged', 'e-runs/sib-001/report.md'],
        ['sib-002', docsBranch, 'merged', 'e-runs/sib-002/report.md'],
        ['sib-003', rewriteBranch, 'merged', 'e-runs/sib-003/report.md'],
        ['sib-004', breakBranch, 'merged', 'e-runs/sib-004/report.md'],
      ]
    );
    assert.equal(
      git(parentWorktree, 'rev-list', '--merges', '--count', 'HEAD'),
      '4'
    );
    const subjects = git(parentWorktree, 'log', '--format=%s').split('\n');
    assert.ok(subjects.includes(`e: merge back ${lookBranch}`));
    assert.ok(subjects.includes(`e: merge back ${docsBranch}`));
    assert.ok(
      subjects.includes(
        `e: merge back ${rewriteBranch} (conflict resolved in e/demo/${parentSlug}-1)`
      )
    );
    // The run's output commit is the merge commit of the open conflict; the
    // reports `finish` rewrote after it got their own commit before the push.
    assert.deepEqual(subjects.slice(0, 2), [
      `e: merge-back reports for e/demo/${parentSlug}-1`,
      `e: run output for e/demo/${parentSlug}-1`,
    ]);
    assert.equal(
      git(parentWorktree, 'log', '-1', '--format=%P', 'HEAD~1').split(' ')
        .length,
      2
    );
    assert.equal(host.isDirty(parentWorktree), false);
    assert.equal(host.mergeInProgress(parentWorktree), false);
    // The reports are part of the run's output, committed with it.
    assert.equal(
      git(parentWorktree, 'ls-files', 'e-runs').split('\n').sort().join(','),
      'e-runs/sib-001/report.md,e-runs/sib-002/report.md,e-runs/sib-003/report.md,e-runs/sib-004/report.md'
    );
    // No remote here: the push is a warning, the run itself succeeded.
    assert.match(result.pushWarning ?? '', /could not push/);
    // The host's own HEAD (main) never moved.
    assert.equal(
      git(repo, 'log', '-1', '--format=%s', 'main'),
      'ignore artifacts and secrets'
    );
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    process.chdir(originalCwd);
    fs.rmSync(worktreesDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
