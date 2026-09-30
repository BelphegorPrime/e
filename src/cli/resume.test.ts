import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import {
  registerResumeCommand,
  resolveResume,
  runResumeCommand,
} from './resume.js';
import { gatherSpawnFacts } from './spawn.js';
import { InMemoryGit } from '../ports/git/memory.js';
import { RunScratch } from '../engine/runs/runScratch.js';
import { Env } from '../shared/utils/env.js';
import {
  agentDir,
  configFilePath,
  dockerfilePath,
  eBaseDir,
} from '../core/store/paths.js';
import { fromBranch, type RunName } from '../core/identity/runName.js';
import {
  openRunSession,
  runSessionDirFor,
  addSessionElapsed,
} from '../engine/runs/runSession.js';
import { brokerSpoolDirFor } from '../engine/runs/runBroker.js';
import {
  ensureSpool,
  writeRequest,
  writeStatus,
} from '../sidecars/broker/contract/spool.js';
import { HARNESSES } from '../core/harness/index.js';
import { FakeRuntime } from '../engine/runs/runSpawn.testSupport.js';
import { DEFAULT_LOOP_CAPS } from '../core/store/config.js';
import { harnessPin, PIN_LABELS } from '../core/harness/pin.js';

// `e resume` (ADR-0017): every refusal happens before any build, image or
// worktree, against a throwaway Store through `--dir`.

const MARKERS = [
  Env.SPAWN_ROLE_VAR,
  Env.SPAWN_PARENT_WORKTREE_VAR,
  Env.SPAWN_PARENT_BRANCH_VAR,
  Env.SPAWN_PARENT_NETWORK_VAR,
  Env.SPAWN_SPOOL_VAR,
  Env.SPAWN_SIBLING_ID_VAR,
  Env.WORKTREES_DIR_VAR,
] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(MARKERS.map(name => [name, process.env[name]]));
  for (const name of MARKERS) delete process.env[name];
});
afterEach(() => {
  for (const name of MARKERS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const branch = 'e/pi/fix-the-bug-2';
const run = fromBranch(branch) as RunName;
const base = { sha: 'orig', branch: 'main' };

/**
 * A runtime whose `isRunning` answers from a set (nothing runs by default)
 * and whose every image carries pi's pin, so the build gate passes.
 */
class Runtime extends FakeRuntime {
  running = new Set<string>();
  override isRunning(name: string): boolean {
    return this.running.has(name);
  }
  override imageLabels(_tag: string): Record<string, string> {
    const pin = harnessPin(HARNESSES.pi);
    return {
      [PIN_LABELS.package]: pin.package,
      [PIN_LABELS.version]: pin.version,
      [PIN_LABELS.skillsCli]: pin.skillsCli,
    };
  }
}

async function withStore<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-resume-cmd-'));
  try {
    fs.mkdirSync(eBaseDir(root), { recursive: true });
    return await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** A stored pi session for {@link branch}, with a transcript in it. */
function storeSession(
  root: string,
  overrides: { harness?: string; harnessVersion?: string } = {}
): void {
  const session = openRunSession(eBaseDir(root), run, {
    init: {
      agent: 'pi',
      harness: overrides.harness ?? 'pi',
      harnessVersion: overrides.harnessVersion ?? HARNESSES.pi.version,
      mcp: [],
      skills: [],
    },
    base,
  });
  const grouped = path.join(session.transcriptDir, '--workspace--');
  fs.mkdirSync(grouped);
  fs.writeFileSync(path.join(grouped, 's.jsonl'), '{}\n');
}

function preflight(
  root: string,
  opts: {
    branch?: string;
    git?: InMemoryGit;
    runtime?: Runtime;
    interactive?: boolean;
    worktreesDir?: string;
  } = {}
) {
  return resolveResume(
    opts.branch ?? branch,
    { dir: root },
    {
      git: opts.git ?? new InMemoryGit({ branches: [branch] }),
      runtime: opts.runtime ?? new Runtime(),
      worktreesDir: opts.worktreesDir ?? path.join(root, 'wt'),
      interactive: opts.interactive ?? false,
    }
  );
}

test('resolveResume: a stored pi session on an existing run branch resumes', async () => {
  await withStore(async root => {
    storeSession(root);
    const target = preflight(root);
    assert.equal(target.run.branch, branch);
    assert.equal(target.record.branch, branch);
    assert.deepEqual(target.record.base, base);
    assert.deepEqual(target.warnings, []);
  });
});

test('resolveResume: a branch that is not a run branch fails fast', async () => {
  await withStore(async root => {
    assert.throws(
      () => preflight(root, { branch: 'main' }),
      /"main" is not a run branch \(e\/<agent>\/<slug>-N\)/
    );
  });
});

test('resolveResume: a harness without resumeCommand fails fast, naming the ones that can', async () => {
  // Every shipped harness can resume, so one is made unable for the test.
  const saved = HARNESSES.claudeCode.resumeCommand;
  HARNESSES.claudeCode.resumeCommand = undefined;
  try {
    await withStore(async root => {
      assert.throws(
        () =>
          preflight(root, {
            branch: 'e/claudeCode/x-1',
            git: new InMemoryGit({ branches: ['e/claudeCode/x-1'] }),
          }),
        /Harness "claudeCode" cannot resume a session: .*e resume supports: pi, codex, opencode/
      );
    });
  } finally {
    HARNESSES.claudeCode.resumeCommand = saved;
  }
});

test('resolveResume: a run branch that does not exist, locally or on origin, is refused', async () => {
  await withStore(async root => {
    storeSession(root);
    assert.throws(
      () => preflight(root, { git: new InMemoryGit() }),
      /no branch e\/pi\/fix-the-bug-2 here or on origin/
    );
    // On origin only is enough.
    assert.ok(
      preflight(root, {
        git: new InMemoryGit({ branches: [`origin/${branch}`] }),
      })
    );
  });
});

test('resolveResume: a branch with no stored session fails fast', async () => {
  await withStore(async root => {
    assert.throws(() => preflight(root), /has no stored session/);
    // A record with an empty transcript is no session either.
    openRunSession(eBaseDir(root), run, {
      init: {
        agent: 'pi',
        harness: 'pi',
        harnessVersion: '1',
        mcp: [],
        skills: [],
      },
      base,
    });
    assert.throws(() => preflight(root), /has no stored session/);
  });
});

test('resolveResume: a session another harness wrote is refused; a new version or provider only warns', async () => {
  await withStore(async root => {
    storeSession(root, { harness: 'codex' });
    assert.throws(
      () => preflight(root),
      /was written by harness "codex".*runs "pi"/
    );
  });
  await withStore(async root => {
    storeSession(root, { harnessVersion: '0.1.0' });
    fs.mkdirSync(agentDir('pi', root), { recursive: true });
    const target = preflight(root);
    assert.equal(target.warnings.length, 1);
    assert.match(target.warnings[0], /pi 0\.1\.0.*now/);
  });
});

test('resolveResume: a provider that changed since the run only warns', async () => {
  await withStore(async root => {
    const dir = agentDir('pi', root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'agent.json'),
      JSON.stringify({
        name: 'pi',
        harness: 'pi',
        provider: {
          baseUrl: 'https://gw.example.com',
          model: 'new-model',
          protocol: 'anthropic-messages',
          apiKeyEnv: 'GW_KEY',
        },
      })
    );
    storeSession(root);
    const target = preflight(root);
    assert.equal(target.warnings.length, 1);
    assert.match(target.warnings[0], /provider changed/);
  });
});

test('resolveResume: a Run that spent its total budget is refused; an interactive resume is not budgeted', async () => {
  await withStore(async root => {
    storeSession(root);
    addSessionElapsed(eBaseDir(root), run, DEFAULT_LOOP_CAPS.totalTimeoutMs);
    assert.throws(() => preflight(root), /spent its whole wall clock/);
    assert.ok(preflight(root, { interactive: true }));
  });
});

test('resolveResume: a live Run, or one with siblings still in flight, is refused', async () => {
  await withStore(async root => {
    storeSession(root);
    const runtime = new Runtime();
    runtime.running.add(run.name);
    assert.throws(() => preflight(root, { runtime }), /is still running/);

    const worktreesDir = path.join(root, 'wt');
    const spool = brokerSpoolDirFor(worktreesDir, run);
    ensureSpool(spool);
    writeRequest(spool, {
      id: 'sib-001',
      agent: 'pi',
      prompt: 'p',
      requestedAt: 'now',
    });
    assert.throws(
      () => preflight(root, { worktreesDir }),
      /siblings still in flight: sib-001/
    );
    writeStatus(spool, 'sib-001', {
      status: 'done',
      exitCode: 0,
      updatedAt: 'now',
    });
    assert.ok(preflight(root, { worktreesDir }));
  });
});

test('resolveResume: a sibling cannot resume anything (depth two)', async () => {
  await withStore(async root => {
    storeSession(root);
    process.env[Env.SPAWN_ROLE_VAR] = 'child';
    process.env[Env.SPAWN_PARENT_WORKTREE_VAR] = '/tmp/p';
    process.env[Env.SPAWN_PARENT_BRANCH_VAR] = 'e/pi/parent-1';
    process.env[Env.SPAWN_SPOOL_VAR] = '/tmp/spool';
    process.env[Env.SPAWN_SIBLING_ID_VAR] = 'sib-001';
    assert.throws(() => preflight(root), /A sibling run cannot resume/);
  });
});

test('gatherSpawnFacts keeps sessions in the Store it found', async () => {
  await withStore(async root => {
    const facts = gatherSpawnFacts('pi', ['hi'], { dir: root });
    assert.equal(facts.sessionStoreDir, eBaseDir(root));
  });
});

test('runResumeCommand: a refusal is exit 1, with nothing built and no worktree', async () => {
  await withStore(async root => {
    const git = new InMemoryGit({ branches: [branch] });
    const runtime = new Runtime();
    const code = await runResumeCommand(
      branch,
      ['go on'],
      { dir: root },
      { scratch: new RunScratch(), git, runtime }
    );
    assert.equal(code, 1);
    assert.deepEqual(runtime.built, []);
    assert.deepEqual(git.checkedOut, []);
  });
});

test('runResumeCommand: continues the session on the Run branch, with its recorded MCP servers and skills', async () => {
  await withStore(async root => {
    process.env[Env.WORKTREES_DIR_VAR] = path.join(root, 'wt');
    fs.mkdirSync(path.dirname(dockerfilePath('pi', root)), { recursive: true });
    fs.writeFileSync(dockerfilePath('pi', root), 'FROM scratch\n');
    fs.writeFileSync(configFilePath(root), '{}');
    storeSession(root);
    const git = new InMemoryGit({ branches: [branch], dirty: true });
    const runtime = new Runtime();
    const code = await runResumeCommand(
      branch,
      ['add', 'a', 'test'],
      { dir: root, rebuild: false },
      { scratch: new RunScratch(), git, runtime }
    );
    assert.equal(code, 0);
    assert.deepEqual(git.worktrees, [], 'no new branch was cut');
    assert.equal(git.checkedOut[0]?.branch, branch);
    const command = runtime.command!;
    assert.deepEqual(command.slice(0, 4), [
      'pi',
      '--no-approve',
      '--continue',
      '-p',
    ]);
    assert.ok(command[4].endsWith('add a test'));
    assert.ok(
      runtime.options?.volumes?.some(
        v =>
          v.container === HARNESSES.pi.sessionDir &&
          v.host === path.join(runSessionDirFor(eBaseDir(root), run), 'harness')
      )
    );
    assert.deepEqual(git.pushed, [branch]);
  });
});

test('registerResumeCommand declares `e resume <branch> [prompt...]`', () => {
  const program = new Command();
  registerResumeCommand(program);
  const resume = program.commands.find(c => c.name() === 'resume');
  assert.ok(resume);
  assert.deepEqual(
    resume.registeredArguments.map(a => a.name()),
    ['branch', 'prompt']
  );
  const flags = resume.options.map(o => o.long);
  for (const flag of [
    '--runtime',
    '--dir',
    '--env-file',
    '--keep-worktree',
    '--no-rebuild',
    '--env',
  ]) {
    assert.ok(flags.includes(flag), flag);
  }
});
