import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import {
  gatherSpawnFacts,
  manualSiblingRequest,
  registerSpawnCommand,
  resolveRemoteTarget,
  spawnReport,
  type SpawnCommandOptions,
} from './spawn.js';
import { validateSpawn } from '../engine/spawn/spawnPlan.js';
import { Env } from '../shared/utils/env.js';
import {
  readRequest,
  writeRunInfo,
} from '../sidecars/broker/contract/spool.js';
import {
  agentDir,
  configFilePath,
  eBaseDir,
  envFilePath,
  mcpDir,
  skillDir,
} from '../core/store/paths.js';

// `gatherSpawnFacts` is the spawn command's one I/O step: it reads the store
// (config, agents, `.env`, MCP servers, skills) and the process markers, and
// hands back a pure `SpawnFacts`. Every test below points it at a throwaway
// store through `--dir`, so no cwd or home-directory walk is involved.

const MARKERS = [
  Env.SPAWN_ROLE_VAR,
  Env.TTY_HEADLESS_VAR,
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

/** Runs `fn` against a fresh store root holding an empty `.e/`, then removes it. */
function withStore<T>(fn: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-spawn-cmd-'));
  try {
    fs.mkdirSync(eBaseDir(root), { recursive: true });
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeAgent(root: string, agent: Record<string, unknown>): void {
  const dir = agentDir(agent.name as string, root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(agent));
}

function writeSkill(root: string, name: string): void {
  fs.mkdirSync(skillDir(name, root), { recursive: true });
  fs.writeFileSync(path.join(skillDir(name, root), 'SKILL.md'), `# ${name}\n`);
}

function writeMcp(root: string, name: string, def: Record<string, unknown>) {
  fs.mkdirSync(mcpDir(name, root), { recursive: true });
  fs.writeFileSync(
    path.join(mcpDir(name, root), 'mcp.json'),
    JSON.stringify(def)
  );
}

function gather(
  root: string,
  target: string | undefined,
  prompt: string[],
  opts: Partial<SpawnCommandOptions> = {}
) {
  return gatherSpawnFacts(target, prompt, { dir: root, ...opts });
}

test('a bare spawn runs the favorite harness (pi by default) with an empty prompt', () => {
  withStore(root => {
    const facts = gather(root, undefined, []);
    assert.equal(facts.root, root);
    assert.deepEqual(facts.agent, { name: 'pi', harness: 'pi' });
    assert.equal(facts.harness.name, 'pi');
    assert.equal(facts.prompt, '');
    assert.equal(typeof facts.stdinIsTty, 'boolean');
    assert.equal(facts.role, 'parent');
    assert.equal(facts.headlessTty, false);
    assert.deepEqual(facts.storeEnv, {});
    assert.deepEqual(facts.mcpServers, []);
    assert.deepEqual(facts.perRunSkills, []);
    assert.deepEqual(facts.bakedSkills, []);
    assert.equal(facts.rebuild, false);
    assert.equal(facts.keepWorktree, false);
    assert.deepEqual(facts.env, []);
    // No `.e/.env` on disk: no base env-file is layered.
    assert.equal(facts.baseEnvFile, undefined);
    // No compose.yaml in the throwaway store: no local stack to bring up.
    assert.equal(facts.localStackPresent, false);
    // The store's settings ride along (defaults without a config.json), so
    // nothing downstream reads config.json a second time.
    assert.deepEqual(facts.siblingArtifacts, ['node_modules']);
    assert.equal(facts.maxSiblings, 3);
    // Older stores predate runtime selection, so the default is llama.cpp.
    assert.deepEqual(facts.localRuntimes, ['llamacpp']);
    assert.equal(facts.gitPlatform, undefined);
    assert.equal(facts.dirOpt, root);
    assert.equal(typeof facts.worktreesDir, 'string');
  });
});

test('an unknown first positional is prompt text for the favorite harness', () => {
  withStore(root => {
    const facts = gather(root, 'fix', ['the', 'bug']);
    assert.deepEqual(facts.agent, { name: 'pi', harness: 'pi' });
    assert.equal(facts.prompt, 'fix the bug');
  });
});

test('config.json picks the favorite harness a bare spawn resolves to', () => {
  withStore(root => {
    fs.writeFileSync(
      configFilePath(root),
      JSON.stringify({
        defaultHarness: 'claudeCode',
        siblingArtifacts: ['dist'],
        maxSiblings: 2,
      })
    );
    // Commander hands the first word over as `target`; unknown -> prompt text.
    const facts = gather(root, 'hello', []);
    assert.deepEqual(facts.agent, {
      name: 'claudeCode',
      harness: 'claudeCode',
    });
    assert.equal(facts.harness.name, 'claudeCode');
    assert.equal(facts.prompt, 'hello');
    assert.deepEqual(facts.siblingArtifacts, ['dist']);
    assert.equal(facts.maxSiblings, 2);
  });
});

test('a persisted agent with a provider loads the store env and layers .e/.env', () => {
  withStore(root => {
    writeAgent(root, {
      name: 'demo',
      harness: 'claudeCode',
      provider: {
        baseUrl: 'http://gw:1/v1',
        model: 'm',
        protocol: 'anthropic-messages',
        apiKeyEnv: 'MY_KEY',
      },
      skills: ['baked'],
    });
    writeSkill(root, 'baked');
    fs.writeFileSync(envFilePath(root), 'MY_KEY=sk-1\nOTHER=2\n');

    const facts = gather(root, 'demo', ['do', 'it']);
    assert.equal(facts.agent.name, 'demo');
    assert.equal(facts.agent.provider?.apiKeyEnv, 'MY_KEY');
    assert.equal(facts.harness.name, 'claudeCode');
    assert.equal(facts.prompt, 'do it');
    assert.deepEqual(facts.storeEnv, { MY_KEY: 'sk-1', OTHER: '2' });
    assert.equal(facts.baseEnvFile, envFilePath(root));
    assert.deepEqual(facts.bakedSkills, ['baked']);
  });
});

test('without a provider or --mcp the store env is not read, though .e/.env is still layered', () => {
  withStore(root => {
    fs.writeFileSync(envFilePath(root), 'MY_KEY=sk-1\n');
    const facts = gather(root, undefined, []);
    assert.deepEqual(facts.storeEnv, {});
    assert.equal(facts.baseEnvFile, envFilePath(root));
  });
});

test('a baked skill the store does not have fails fast', () => {
  withStore(root => {
    writeAgent(root, { name: 'demo', harness: 'pi', skills: ['missing'] });
    assert.throws(() => gather(root, 'demo', ['x']), /Unknown skill "missing"/);
  });
});

test('--mcp resolves persisted servers and reads the store env for their credentials', () => {
  withStore(root => {
    writeMcp(root, 'everything', {
      transport: 'container',
      port: 3001,
      requiredEnv: [],
    });
    fs.writeFileSync(envFilePath(root), 'TOKEN=t\n');
    const facts = gather(root, 'x', [], { mcp: ['everything'] });
    assert.deepEqual(facts.mcpServers, [
      {
        name: 'everything',
        transport: 'container',
        port: 3001,
        requiredEnv: [],
      },
    ]);
    assert.deepEqual(facts.storeEnv, { TOKEN: 't' });
  });
});

test('--mcp with an unknown name lists the available servers', () => {
  withStore(root => {
    writeMcp(root, 'everything', { transport: 'container', port: 3001 });
    assert.throws(
      () => gather(root, 'x', [], { mcp: ['nope'] }),
      /Unknown MCP server "nope"\. Available: everything\./
    );
  });
});

test('--skill accepts comma-separated and repeated names, each checked on disk', () => {
  withStore(root => {
    for (const name of ['a', 'b', 'c']) writeSkill(root, name);
    const facts = gather(root, 'x', [], { skill: ['a,b', 'c', 'a'] });
    assert.deepEqual(facts.perRunSkills, ['a', 'b', 'c']);
    assert.throws(
      () => gather(root, 'x', [], { skill: ['a,zzz'] }),
      /Unknown skill "zzz"/
    );
  });
});

test('a promptless spawn is refused before anything is built when stdin is no terminal', () => {
  withStore(root => {
    const bare = gather(root, undefined, []);
    assert.equal(bare.prompt, '');
    // The gathered facts carry the real stdin state; the rule is checked with
    // both values so the test does not depend on how it is run.
    assert.throws(
      () => validateSpawn({ ...bare, stdinIsTty: false }),
      /No prompt and no terminal/
    );
    assert.doesNotThrow(() => validateSpawn({ ...bare, stdinIsTty: true }));
    // A prompt always passes, terminal or not.
    const facts = gather(root, 'go', []);
    assert.doesNotThrow(() => validateSpawn({ ...facts, stdinIsTty: false }));
  });
});

test('the process markers set the role and the headless-TTY flag', () => {
  withStore(root => {
    process.env[Env.SPAWN_ROLE_VAR] = 'child';
    process.env[Env.TTY_HEADLESS_VAR] = '1';
    const facts = gather(root, undefined, []);
    assert.equal(facts.role, 'child');
    assert.equal(facts.headlessTty, true);

    process.env[Env.SPAWN_ROLE_VAR] = 'grandchild';
    assert.throws(
      () => gather(root, undefined, []),
      /Unknown run role "grandchild" in E_SPAWN_ROLE/
    );
  });
});

test('CLI options pass through to the facts by their fact names', () => {
  withStore(root => {
    const facts = gather(root, 'x', [], {
      name: 'my-run',
      env: ['A=1', 'B=2'],
      port: ['8080:80'],
      rm: false,
      rebuild: true,
      keepWorktree: true,
      envFile: '/tmp/user.env',
    });
    assert.equal(facts.name, 'my-run');
    assert.deepEqual(facts.env, ['A=1', 'B=2']);
    assert.deepEqual(facts.port, ['8080:80']);
    assert.equal(facts.rm, false);
    assert.equal(facts.rebuild, true);
    assert.equal(facts.keepWorktree, true);
    assert.equal(facts.userEnvFile, '/tmp/user.env');
  });
});

// The Commander surface: `registerSpawnCommand` declares the arguments and
// options the action receives. The real action builds images and runs
// containers, so it is swapped for a recorder before parsing.
interface Parsed {
  target: string | undefined;
  prompt: string[];
  opts: SpawnCommandOptions;
}

async function parseSpawn(argv: string[]): Promise<Parsed> {
  const program = new Command();
  program.exitOverride();
  registerSpawnCommand(program);
  const spawn = program.commands.find(c => c.name() === 'spawn');
  assert.ok(spawn, 'registerSpawnCommand adds a "spawn" command');
  let parsed: Parsed | undefined;
  spawn.action(
    (
      target: string | undefined,
      prompt: string[],
      opts: SpawnCommandOptions
    ) => {
      parsed = { target, prompt, opts };
    }
  );
  await program.parseAsync(['spawn', ...argv], { from: 'user' });
  assert.ok(parsed, 'the spawn action ran');
  return parsed;
}

test('spawn CLI: target and prompt words are positional; --rm defaults on', async () => {
  const { target, prompt, opts } = await parseSpawn([
    'demo',
    'fix',
    'the',
    'bug',
  ]);
  assert.equal(target, 'demo');
  assert.deepEqual(prompt, ['fix', 'the', 'bug']);
  assert.equal(opts.rm, true);
  assert.equal(opts.rebuild, false);
  assert.equal(opts.mcp, undefined);
  assert.equal(opts.skill, undefined);
});

test('spawn CLI: no positionals at all is allowed (favorite harness, TUI)', async () => {
  const { target, prompt } = await parseSpawn([]);
  assert.equal(target, undefined);
  assert.deepEqual(prompt, []);
});

test('spawn CLI: every option parses to the field the action reads', async () => {
  const { target, prompt, opts } = await parseSpawn([
    'demo',
    'go',
    '--runtime',
    'podman',
    '--name',
    'my-run',
    '--env-file',
    'user.env',
    '--mcp',
    'a',
    'b',
    '--skill',
    's1,s2',
    '--skill',
    's3',
    '--rebuild',
    '--dir',
    '/store',
    '--no-rm',
    '--keep-worktree',
    '--parent',
    'e/demo/my-run-1',
    '-p',
    '8080:80',
    '-p',
    '9000:90',
    '-e',
    'X=1',
    '-e',
    'Y=2',
  ]);
  assert.equal(target, 'demo');
  assert.deepEqual(prompt, ['go']);
  assert.equal(opts.runtime, 'podman');
  assert.equal(opts.name, 'my-run');
  assert.equal(opts.envFile, 'user.env');
  assert.deepEqual(opts.mcp, ['a', 'b']);
  assert.deepEqual(opts.skill, ['s1,s2', 's3']);
  assert.equal(opts.rebuild, true);
  assert.equal(opts.dir, '/store');
  assert.equal(opts.rm, false);
  assert.equal(opts.keepWorktree, true);
  assert.equal(opts.parent, 'e/demo/my-run-1');
  assert.deepEqual(opts.port, ['8080:80', '9000:90']);
  assert.deepEqual(opts.env, ['X=1', 'Y=2']);
});

test('a shipped skill missing from an older store is seeded when a spawn asks for it', () => {
  withStore(root => {
    const facts = gather(root, 'x', [], { skill: ['spawn-brother'] });
    assert.deepEqual(facts.perRunSkills, ['spawn-brother']);
    assert.ok(
      fs.existsSync(path.join(skillDir('spawn-brother', root), 'SKILL.md'))
    );
    assert.ok(
      fs.existsSync(
        path.join(skillDir('spawn-brother', root), 'spawn-brother.mjs')
      )
    );
    // A skill that is not shipped is still an error.
    assert.throws(
      () => gather(root, 'x', [], { skill: ['nope'] }),
      /Unknown skill "nope"/
    );
  });
});

test('the sibling markers reach the facts as the sibling to report to', () => {
  withStore(root => {
    process.env[Env.SPAWN_ROLE_VAR] = 'child';
    process.env[Env.SPAWN_PARENT_WORKTREE_VAR] = '/wt/parent';
    process.env[Env.SPAWN_PARENT_BRANCH_VAR] = 'e/demo/parent-1';
    process.env[Env.SPAWN_PARENT_NETWORK_VAR] = 'e-demo-parent-1-net';
    process.env[Env.SPAWN_SPOOL_VAR] = '/wt/.broker/e-demo-parent-1';
    process.env[Env.SPAWN_SIBLING_ID_VAR] = 'sib-001';
    const facts = gather(root, 'x', []);
    assert.equal(facts.role, 'child');
    assert.deepEqual(facts.sibling, {
      parent: {
        worktreePath: '/wt/parent',
        branch: 'e/demo/parent-1',
        network: 'e-demo-parent-1-net',
      },
      spoolDir: '/wt/.broker/e-demo-parent-1',
      id: 'sib-001',
    });
  });
});

// Remote A2A agents (ADR-0015) short-circuit the pipeline: `resolveRemoteTarget`
// answers before any fact is gathered; `gatherSpawnFacts` refuses one.

test('resolveRemoteTarget: a remote agent target yields the agent, the joined prompt and the store env; a harness target yields nothing', () => {
  withStore(root => {
    writeAgent(root, {
      name: 'remote',
      transport: 'a2a',
      url: 'https://agents.example.com/a2a',
      headers: { Authorization: 'Bearer ${REMOTE_TOKEN}' },
    });
    fs.writeFileSync(envFilePath(root), 'REMOTE_TOKEN=abc\n');
    const remote = resolveRemoteTarget('remote', ['what', 'is', 'X'], {
      dir: root,
    });
    assert.ok(remote);
    assert.equal(remote.agent.name, 'remote');
    assert.equal(remote.prompt, 'what is X');
    assert.equal(remote.storeEnv.REMOTE_TOKEN, 'abc');
    assert.equal(resolveRemoteTarget('pi', ['hi'], { dir: root }), undefined);
    assert.throws(
      () => gatherSpawnFacts('remote', ['what is X'], { dir: root }),
      /remote A2A agent and has no harness/
    );
  });
});

// The manual child request (`--parent <branch>`, ADR-0013): a human-written
// sibling request. The parent run is live when its broker spool exists and
// names a `parent`-role run; only a live parent can take children, and only
// a depth-two request may be written at all.

/** A fake live parent run: its worktree plus a broker spool with run.json. */
function writeLiveParent(
  worktrees: string,
  branch: string,
  agent: string,
  role: 'parent' | 'child' = 'parent'
): string {
  const slug = branch.split('/').join('-');
  fs.mkdirSync(path.join(worktrees, ...branch.split('/')), { recursive: true });
  const spool = path.join(worktrees, '.broker', slug);
  fs.mkdirSync(spool, { recursive: true });
  writeRunInfo(spool, {
    name: slug,
    branch,
    agent,
    role,
    maxSiblings: 3,
  });
  return spool;
}

test('manualSiblingRequest: --parent writes a request into the live parent run broker spool and returns the accepted shape', () => {
  const worktrees = fs.mkdtempSync(path.join(os.tmpdir(), 'e-wt-'));
  try {
    const old = process.env[Env.WORKTREES_DIR_VAR];
    process.env[Env.WORKTREES_DIR_VAR] = worktrees;
    try {
      withStore(root => {
        const spool = writeLiveParent(worktrees, 'e/dev/parent-1', 'dev');
        const accepted = manualSiblingRequest('pi', ['write', 'docs'], {
          dir: root,
          parent: 'e/dev/parent-1',
        });
        assert.equal(accepted.status, 'requested');
        assert.equal(accepted.id, 'sib-001');
        assert.equal(accepted.statusPath, '/status/sib-001');
        const request = readRequest(spool, 'sib-001');
        assert.ok(request);
        assert.equal(request.agent, 'pi');
        assert.equal(request.prompt, 'write docs');
      });
    } finally {
      if (old === undefined) delete process.env[Env.WORKTREES_DIR_VAR];
      else process.env[Env.WORKTREES_DIR_VAR] = old;
    }
  } finally {
    fs.rmSync(worktrees, { recursive: true, force: true });
  }
});

test('manualSiblingRequest: survives the parent worktree missing and a parent with no broker spool', () => {
  const worktrees = fs.mkdtempSync(path.join(os.tmpdir(), 'e-wt-'));
  try {
    const old = process.env[Env.WORKTREES_DIR_VAR];
    process.env[Env.WORKTREES_DIR_VAR] = worktrees;
    try {
      withStore(root => {
        // A branch with no worktree is not a live run.
        assert.throws(
          () =>
            manualSiblingRequest('pi', ['x'], {
              dir: root,
              parent: 'e/dev/ghost-1',
            }),
          /no live worktree/
        );
        // A worktree whose run has no broker spool cannot take children.
        const branch = 'e/dev/nobroker-1';
        fs.mkdirSync(path.join(worktrees, ...branch.split('/')), {
          recursive: true,
        });
        assert.throws(
          () =>
            manualSiblingRequest('pi', ['x'], {
              dir: root,
              parent: branch,
            }),
          /no runtime-broker/
        );
      });
    } finally {
      if (old === undefined) delete process.env[Env.WORKTREES_DIR_VAR];
      else process.env[Env.WORKTREES_DIR_VAR] = old;
    }
  } finally {
    fs.rmSync(worktrees, { recursive: true, force: true });
  }
});

test('manualSiblingRequest: depth stays two - a child parent and a sibling caller are both refused', () => {
  const worktrees = fs.mkdtempSync(path.join(os.tmpdir(), 'e-wt-'));
  try {
    const old = process.env[Env.WORKTREES_DIR_VAR];
    process.env[Env.WORKTREES_DIR_VAR] = worktrees;
    try {
      withStore(root => {
        // A spool whose run is itself a child (role=E_ROLE child) cannot
        // take children: that would be the grandchildren ADR-0013 forbids.
        const childBranch = 'e/dev/deep-1';
        writeLiveParent(worktrees, childBranch, 'dev', 'child');
        assert.throws(
          () =>
            manualSiblingRequest('pi', ['x'], {
              dir: root,
              parent: childBranch,
            }),
          /itself a child/
        );
        // A caller that already wears the sibling markers is itself a child:
        // its manual child would be depth three.
        writeLiveParent(worktrees, 'e/dev/parent-1', 'dev');
        process.env[Env.SPAWN_ROLE_VAR] = 'child';
        process.env[Env.SPAWN_PARENT_WORKTREE_VAR] = '/wt/parent';
        process.env[Env.SPAWN_PARENT_BRANCH_VAR] = 'e/dev/parent-1';
        process.env[Env.SPAWN_SPOOL_VAR] = path.join(worktrees, '.broker');
        process.env[Env.SPAWN_SIBLING_ID_VAR] = 'sib-001';
        assert.throws(
          () =>
            manualSiblingRequest('pi', ['x'], {
              dir: root,
              parent: 'e/dev/parent-1',
            }),
          /depth is capped at two/
        );
      });
    } finally {
      if (old === undefined) delete process.env[Env.WORKTREES_DIR_VAR];
      else process.env[Env.WORKTREES_DIR_VAR] = old;
    }
  } finally {
    fs.rmSync(worktrees, { recursive: true, force: true });
  }
});

test('manualSiblingRequest: a prompt is required, and an unknown --parent branch is refused', () => {
  withStore(root => {
    assert.throws(
      () => manualSiblingRequest(undefined, [], { dir: root, parent: 'main' }),
      /run branch \(e\/<agent>\/<slug>-N\)/
    );
  });
  const worktrees = fs.mkdtempSync(path.join(os.tmpdir(), 'e-wt-'));
  try {
    const old = process.env[Env.WORKTREES_DIR_VAR];
    process.env[Env.WORKTREES_DIR_VAR] = worktrees;
    try {
      withStore(root => {
        writeLiveParent(worktrees, 'e/dev/parent-1', 'dev');
        assert.throws(
          () =>
            manualSiblingRequest(undefined, [], {
              dir: root,
              parent: 'e/dev/parent-1',
            }),
          /manual child needs a prompt/
        );
      });
    } finally {
      if (old === undefined) delete process.env[Env.WORKTREES_DIR_VAR];
      else process.env[Env.WORKTREES_DIR_VAR] = old;
    }
  } finally {
    fs.rmSync(worktrees, { recursive: true, force: true });
  }
});

// What a finished run tells the user. The whole tail of the spawn action used
// to live in the anonymous action closure this file replaces with a recorder,
// so none of it was reachable from a test; as data it is asserted directly.

test('spawnReport: an error is the only thing a failed run says', () => {
  assert.deepEqual(
    spawnReport({ ran: true, exitCode: 2, error: 'image build failed' }),
    [{ level: 'error', text: 'image build failed' }]
  );
});

test('spawnReport: the run branch is always the last thing a success says', () => {
  assert.deepEqual(
    spawnReport({ ran: true, exitCode: 0, branch: 'e/pi/fix-login-1' }),
    [{ level: 'success', text: '\nRun branch: e/pi/fix-login-1' }]
  );
});

test('spawnReport: push, PR and capture lines, in the order they happened', () => {
  assert.deepEqual(
    spawnReport({
      ran: true,
      exitCode: 0,
      branch: 'e/pi/fix-login-1',
      pushed: true,
      pullRequestUrl: 'https://example.com/pr/1',
      captured: true,
    }),
    [
      {
        level: 'success',
        text: 'Pushed to origin. Open a PR or merge when you like.',
      },
      { level: 'success', text: 'Pull request: https://example.com/pr/1' },
      { level: 'success', text: '\nRun branch: e/pi/fix-login-1' },
      {
        level: 'success',
        text: 'Captured uncommitted changes in a host commit.',
      },
    ]
  );
});

test('spawnReport: a push or PR warning is a warning, not a failure', () => {
  const lines = spawnReport({
    ran: true,
    exitCode: 0,
    branch: 'e/pi/fix-login-1',
    pushWarning: 'no origin',
    pullRequestWarning: 'gh not installed',
  });
  assert.deepEqual(
    lines.filter(line => line.level === 'warn'),
    [
      { level: 'warn', text: 'Warning: no origin' },
      { level: 'warn', text: 'Warning: gh not installed' },
    ]
  );
});

test('spawnReport: a sibling whose work landed is info, one that did not is a warning', () => {
  const lines = spawnReport({
    ran: true,
    exitCode: 0,
    branch: 'e/pi/fix-login-1',
    siblings: [
      {
        id: 'sib-001',
        agent: 'pi',
        branch: 'e/pi/tests-1',
        status: 'done',
        merge: { status: 'merged' },
      },
      {
        id: 'sib-002',
        agent: 'pi',
        branch: 'e/pi/docs-1',
        status: 'done',
        merge: { status: 'conflict', reason: 'README.md' },
      },
    ],
  });
  assert.deepEqual(
    lines.filter(line => line.text.startsWith('Sibling')),
    [
      {
        level: 'info',
        text: 'Sibling sib-001 (pi, e/pi/tests-1): done, merge-back merged',
      },
      {
        level: 'warn',
        text: 'Sibling sib-002 (pi, e/pi/docs-1): done, merge-back conflict - README.md',
      },
    ]
  );
});

test('spawnReport: a gated run prints one line per attempt, then how the loop ended', () => {
  const lines = spawnReport({
    ran: true,
    exitCode: 0,
    branch: 'e/demo/fix-1',
    iterations: [
      {
        attempt: 1,
        harnessExitCode: 0,
        commit: 'aaa',
        verdict: 'red',
        verifyExitCode: 1,
      },
      {
        attempt: 2,
        harnessExitCode: 0,
        commit: 'bbb',
        verdict: 'green',
        verifyExitCode: 0,
      },
    ],
    outcome: 'verified',
  }).map(l => l.text);
  assert.ok(lines.some(t => /Attempt 1: verify red \(exited 1\)/.test(t)));
  assert.ok(lines.some(t => /Attempt 2: verify green/.test(t)));
  assert.ok(lines.some(t => /Verified after 2 attempts/.test(t)));
});

test('spawnReport: an exhausted run says so, and a dead harness is named as aborted', () => {
  const exhausted = spawnReport({
    ran: true,
    exitCode: 1,
    branch: 'e/demo/fix-1',
    iterations: [
      { attempt: 1, harnessExitCode: 0, verdict: 'red', verifyExitCode: 1 },
    ],
    outcome: 'exhausted',
  }).map(l => l.text);
  assert.ok(exhausted.some(t => /Exhausted after 1 attempt/.test(t)));

  const aborted = spawnReport({
    ran: true,
    exitCode: 1,
    branch: 'e/demo/fix-1',
    iterations: [{ attempt: 2, harnessExitCode: 137 }],
    outcome: 'aborted',
  }).map(l => l.text);
  assert.ok(aborted.some(t => /Attempt 2: the harness exited 137/.test(t)));
  assert.ok(aborted.some(t => /Aborted/.test(t)));
});

test('spawnReport: a run with no gate says nothing about attempts', () => {
  const lines = spawnReport({
    ran: true,
    exitCode: 0,
    branch: 'e/demo/fix-1',
    pushed: true,
  }).map(l => l.text);
  assert.ok(!lines.some(t => /Attempt|Verified|Exhausted/.test(t)));
});
