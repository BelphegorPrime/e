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
  resolveTriggerSpawn,
  runSpawnCommand,
  spawnReport,
  type SpawnCommandOptions,
  type TriggeredSpawn,
} from './spawn.js';
import { planSpawn, validateSpawn } from '../engine/spawn/spawnPlan.js';
import { filterEnvContent } from '../shared/utils/dotenv.js';
import { InMemoryGit } from '../ports/git/memory.js';
import { RunScratch } from '../engine/runs/runScratch.js';
import { Env } from '../shared/utils/env.js';
import { SPAWN_FLAGS } from '../shared/spawnArgs.js';
import {
  readRequest,
  writeRunInfo,
} from '../sidecars/broker/contract/spool.js';
import {
  agentDir,
  configFilePath,
  dockerfilePath,
  eBaseDir,
  envFilePath,
  mcpDir,
  skillDir,
  triggerConfigPath,
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
  Env.GITHUB_EVENT_NAME_VAR,
  Env.STORE_ENV_FILE_VAR,
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
    // Every spawn rebuilds its images unless told not to (ADR-0016 section 10).
    assert.equal(facts.rebuild, true);
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
  // Neither flag given: Commander leaves it unset, and the facts read that as a rebuild.
  assert.equal(opts.rebuild, undefined);
  assert.equal(opts.mcp, undefined);
  assert.equal(opts.skill, undefined);
});

test('spawn CLI: --no-rebuild opts out, --rebuild still parses, the last one wins', async () => {
  const cases: [string[], boolean | undefined, boolean][] = [
    [[], undefined, true],
    [[SPAWN_FLAGS.rebuild], true, true],
    [[SPAWN_FLAGS.noRebuild], false, false],
    [[SPAWN_FLAGS.rebuild, SPAWN_FLAGS.noRebuild], false, false],
    [[SPAWN_FLAGS.noRebuild, SPAWN_FLAGS.rebuild], true, true],
  ];
  for (const [flags, parsed, rebuild] of cases) {
    const { opts } = await parseSpawn(['demo', ...flags, 'go']);
    assert.equal(opts.rebuild, parsed, flags.join(' '));
    withStore(root => {
      const facts = gather(root, undefined, [], { rebuild: opts.rebuild });
      assert.equal(facts.rebuild, rebuild, flags.join(' '));
    });
  }
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

test('spawnReport: gate removals qualify "verified" and are always stated; 0/0 qualifies nothing', () => {
  const weakened = spawnReport({
    ran: true,
    exitCode: 0,
    branch: 'e/pi/fix-login-1',
    iterations: [{ attempt: 1, harnessExitCode: 0, verdict: 'green' }],
    outcome: 'verified',
    gateRemovals: { files: 2, lines: 47 },
  });
  assert.ok(
    weakened.some(
      l =>
        l.level === 'warn' &&
        l.text ===
          'Verified after 1 attempt (gate weakened: 2 files, -47 lines).'
    )
  );
  assert.ok(
    weakened.some(l =>
      l.text.startsWith('Gate removals (lines deleted under verify.guards')
    )
  );

  const clean = spawnReport({
    ran: true,
    exitCode: 0,
    branch: 'e/pi/fix-login-1',
    iterations: [{ attempt: 1, harnessExitCode: 0, verdict: 'green' }],
    outcome: 'verified',
    gateRemovals: { files: 0, lines: 0 },
  });
  assert.ok(
    clean.some(
      l => l.level === 'success' && l.text === 'Verified after 1 attempt.'
    )
  );
  assert.ok(clean.some(l => l.text.endsWith('0 files, -0 lines.')));

  // Not verified: no claim to qualify, the numbers still recorded.
  const exhausted = spawnReport({
    ran: true,
    exitCode: 2,
    branch: 'e/pi/fix-login-1',
    iterations: [
      { attempt: 1, harnessExitCode: 0, verdict: 'red', verifyExitCode: 1 },
    ],
    outcome: 'exhausted',
    reason: 'exhausted:iterations',
    gateRemovals: { files: 1, lines: 3 },
  });
  assert.ok(!exhausted.some(l => /gate weakened/.test(l.text)));
  assert.ok(exhausted.some(l => l.text.endsWith('1 file, -3 lines.')));
});

test('spawnReport: where unmerged sibling work went, and why the host stopped committing', () => {
  const lines = spawnReport({
    ran: true,
    exitCode: 1,
    branch: 'e/pi/fix-login-1',
    siblingBranchesPushed: ['e/pi/docs-1'],
    siblingPushWarnings: [
      'could not push e/pi/tests-1 (sibling sib-001, not merged): no origin',
    ],
    mergeWarning: 'a merge-back conflict could not be abandoned (not uptodate)',
  });
  assert.deepEqual(lines.slice(0, 3), [
    { level: 'info', text: 'Pushed unmerged sibling e/pi/docs-1.' },
    {
      level: 'warn',
      text: 'Warning: could not push e/pi/tests-1 (sibling sib-001, not merged): no origin',
    },
    {
      level: 'warn',
      text: 'Warning: a merge-back conflict could not be abandoned (not uptodate)',
    },
  ]);
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

test('spawnReport: a bad end names the budget that ran out, not just the fact', () => {
  const lines = spawnReport({
    ran: true,
    exitCode: 2,
    branch: 'e/demo/fix-1',
    iterations: [{ attempt: 1, harnessExitCode: 137 }],
    outcome: 'exhausted',
    reason: 'exhausted:iteration-timeout',
  }).map(l => l.text);
  assert.ok(lines.some(t => t.includes('exhausted:iteration-timeout')));
});

test('spawnReport: the soft time limit is a warning for the human', () => {
  const lines = spawnReport({
    ran: true,
    exitCode: 0,
    branch: 'e/demo/fix-1',
    softTimeoutWarning: 'Past the soft time limit (120 min) at attempt 3.',
  }).map(l => l.text);
  assert.ok(lines.some(t => /soft time limit/.test(t)));
});

// --- --trigger: the one-shot shape (ADR-0016 section 13) --------------------

const ORIGIN_MAIN = 'refs/remotes/origin/main';

/** {@link withStore} for an async body: the store outlives the promise. */
async function withStoreAsync(fn: (root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-spawn-cmd-'));
  try {
    fs.mkdirSync(eBaseDir(root), { recursive: true });
    await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const labeledTrigger = {
  agent: 'claudeCode',
  prompt: 'Fix issue #{{issue.number}}.',
  loop: { maxIterations: 2 },
  on: {
    type: 'webhook',
    source: 'github',
    event: 'issues',
    action: 'labeled',
    match: { 'label.name': 'agent' },
  },
};

/**
 * What `main` commits under `.e/` besides the trigger: the harness the
 * trigger's agent builds from, and `extra`, both by path under `.e/`.
 */
function committedStore(
  root: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  const files = { 'harnesses/claudeCode/Dockerfile': 'FROM base\n', ...extra };
  return Object.fromEntries(
    Object.entries(files).map(([file, content]) => [
      path.join(eBaseDir(root), file),
      content,
    ])
  );
}

/**
 * A git whose default branch carries `declaration` as the trigger `fix`,
 * the rest of its Store `store` (see {@link committedStore}), and `head`,
 * files committed in HEAD only (host paths).
 */
function triggerGit(
  root: string,
  declaration: unknown,
  store: Record<string, string> = {},
  head: Record<string, string> = {}
): InMemoryGit {
  return new InMemoryGit({
    toplevel: root,
    defaultBranchRef: ORIGIN_MAIN,
    refCommits: { [ORIGIN_MAIN]: 'main-sha' },
    files: {
      [ORIGIN_MAIN]: {
        ...committedStore(root, store),
        [triggerConfigPath('fix', root)]: JSON.stringify(declaration),
      },
      HEAD: head,
    },
  });
}

/** A payload-free trigger, so a test needs no event file. */
const nightlyTrigger = {
  agent: 'claudeCode',
  prompt: 'Nightly {{tick}}.',
  on: { type: 'cron', expr: '0 3 * * *' },
};

/**
 * Resolves the trigger `fix` as a run to start, its Base Store in
 * `scratch`, which the caller disposes of.
 */
function triggered(
  root: string,
  git: InMemoryGit,
  scratch: RunScratch,
  opts: Partial<SpawnCommandOptions> = {}
): TriggeredSpawn {
  const out = resolveTriggerSpawn(
    undefined,
    [],
    { dir: root, trigger: 'fix', ...opts },
    { git, scratch }
  );
  if ('skip' in out) throw new Error(`the trigger was skipped: ${out.skip}`);
  return out;
}

/** The facts of the run `triggered` resolved, gathered as the action does. */
function triggeredFacts(
  root: string,
  out: TriggeredSpawn,
  opts: Partial<SpawnCommandOptions> = {}
) {
  return gatherSpawnFacts(
    out.agent,
    [out.prompt],
    { dir: root, name: out.name, ...opts },
    out
  );
}

function writePayload(root: string, label: string): string {
  const file = path.join(root, 'event.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      action: 'labeled',
      label: { name: label },
      issue: { number: 42 },
    })
  );
  return file;
}

test('--trigger: the declaration supplies agent, prompt, name, base, payload and loop', () => {
  withStore(root => {
    const event = writePayload(root, 'agent');
    process.env[Env.GITHUB_EVENT_NAME_VAR] = 'issues';
    const scratch = new RunScratch();
    try {
      const out = triggered(root, triggerGit(root, labeledTrigger), scratch, {
        event,
      });
      const { store, ...rest } = out;
      assert.deepEqual(rest, {
        agent: 'claudeCode',
        prompt: 'Fix issue #42.',
        name: 'fix',
        base: { ref: ORIGIN_MAIN, sha: 'main-sha', branch: 'main' },
        eventFile: event,
        loop: { maxIterations: 2 },
      });
      assert.equal(store.checkoutRoot, root);
      assert.notEqual(store.root, root);
      // The spawn facts carry them on, the loop field-wise over the Store's.
      const facts = triggeredFacts(root, out);
      assert.equal(facts.root, store.root);
      assert.equal(facts.agent.name, 'claudeCode');
      assert.equal(facts.prompt, 'Fix issue #42.');
      assert.equal(facts.name, 'fix');
      assert.deepEqual(facts.base, out.base);
      assert.equal(facts.eventFile, event);
      assert.equal(facts.loop?.maxIterations, 2);
      assert.ok((facts.loop?.totalTimeoutMs ?? 0) > 0);
    } finally {
      scratch.dispose();
    }
  });
});

test('--trigger: --event-name wins over $GITHUB_EVENT_NAME', () => {
  withStore(root => {
    process.env[Env.GITHUB_EVENT_NAME_VAR] = 'issues';
    const out = resolveTriggerSpawn(
      undefined,
      [],
      {
        dir: root,
        trigger: 'fix',
        event: writePayload(root, 'agent'),
        eventName: 'pull_request',
      },
      { git: triggerGit(root, labeledTrigger), scratch: new RunScratch() }
    );
    assert.ok('skip' in out);
  });
});

test('--trigger: positional arguments are refused, the declaration decides', () => {
  withStore(root => {
    assert.throws(
      () =>
        resolveTriggerSpawn(
          'claudeCode',
          ['do', 'it'],
          { dir: root, trigger: 'fix' },
          { git: triggerGit(root, labeledTrigger), scratch: new RunScratch() }
        ),
      /takes its agent and prompt from the declaration/
    );
  });
});

test('--trigger: a payload that does not match starts no run and exits 0', async () => {
  await withStoreAsync(async root => {
    const git = triggerGit(root, labeledTrigger);
    const code = await runSpawnCommand(
      undefined,
      [],
      {
        dir: root,
        trigger: 'fix',
        event: writePayload(root, 'wontfix'),
        eventName: 'issues',
      },
      { scratch: new RunScratch(), git }
    );
    assert.equal(code, 0);
    assert.equal(git.worktrees.length, 0);
  });
});

test('--trigger: a trigger that cannot load is an error, exit 1', async () => {
  await withStoreAsync(async root => {
    // Payload paths and no --event: refused at load, not rendered empty.
    const code = await runSpawnCommand(
      undefined,
      [],
      { dir: root, trigger: 'fix' },
      { scratch: new RunScratch(), git: triggerGit(root, labeledTrigger) }
    );
    assert.equal(code, 1);
  });
});

test('--event without --trigger is refused', async () => {
  await withStoreAsync(async root => {
    const code = await runSpawnCommand(
      'claudeCode',
      ['hi'],
      { dir: root, event: writePayload(root, 'agent') },
      { scratch: new RunScratch(), git: new InMemoryGit() }
    );
    assert.equal(code, 1);
  });
});

test('--trigger: a remote A2A agent is refused, it has no base or payload mount', async () => {
  await withStoreAsync(async root => {
    const remote = {
      name: 'faraway',
      transport: 'a2a',
      url: 'https://agents.example.com/a2a',
    };
    const code = await runSpawnCommand(
      undefined,
      [],
      { dir: root, trigger: 'fix' },
      {
        scratch: new RunScratch(),
        git: triggerGit(
          root,
          { ...nightlyTrigger, agent: 'faraway' },
          { 'agents/faraway/agent.json': JSON.stringify(remote) }
        ),
      }
    );
    assert.equal(code, 1);
  });
});

// --- --trigger: the Base Store (ADR-0016 section 13, #197) ------------------

test('--trigger: the gate is the one committed at base, whatever the working tree says', () => {
  withStore(root => {
    // The PR head weakens verify in the checkout's config.json.
    fs.writeFileSync(
      configFilePath(root),
      JSON.stringify({ verify: { command: 'true' } })
    );
    const scratch = new RunScratch();
    try {
      const out = triggered(
        root,
        triggerGit(root, nightlyTrigger, {
          'config.json': JSON.stringify({
            verify: { command: 'npm test', guards: ['test/**'] },
            siblingArtifacts: ['vendor'],
          }),
        }),
        scratch
      );
      const facts = triggeredFacts(root, out);
      assert.equal(facts.verify?.command, 'npm test');
      assert.deepEqual(facts.verify?.guards, ['test/**']);
      assert.deepEqual(facts.siblingArtifacts, ['vendor']);
      // The verify cache is named after the checkout's Store, never the
      // scratch copy: the same volume a manual spawn in this checkout uses.
      assert.equal(
        facts.cacheVolume,
        gather(root, 'claudeCode', ['x']).cacheVolume
      );
    } finally {
      scratch.dispose();
    }
  });
});

test("--trigger: the agent and its harness Dockerfile are base's, not the head's", () => {
  withStore(root => {
    // The head swaps the agent's harness and rewrites the Dockerfile.
    writeAgent(root, { name: 'fixer', harness: 'pi' });
    fs.mkdirSync(path.join(eBaseDir(root), 'harnesses', 'claudeCode'), {
      recursive: true,
    });
    fs.writeFileSync(dockerfilePath('claudeCode', root), 'FROM evil\n');
    const scratch = new RunScratch();
    try {
      const out = triggered(
        root,
        triggerGit(
          root,
          { ...nightlyTrigger, agent: 'fixer' },
          {
            'agents/fixer/agent.json': JSON.stringify({
              name: 'fixer',
              harness: 'claudeCode',
            }),
          }
        ),
        scratch
      );
      const facts = triggeredFacts(root, out);
      assert.equal(facts.agent.harness, 'claudeCode');
      // The image is built from the Store root the facts carry.
      assert.equal(
        fs.readFileSync(dockerfilePath('claudeCode', facts.root), 'utf8'),
        'FROM base\n'
      );
    } finally {
      scratch.dispose();
    }
  });
});

test('--trigger: a nested .e/ closer to the cwd does not move the Store root', () => {
  withStore(root => {
    const nested = path.join(root, 'pkg');
    fs.mkdirSync(eBaseDir(nested), { recursive: true });
    fs.writeFileSync(
      configFilePath(nested),
      JSON.stringify({ verify: { command: 'true' } })
    );
    const git = triggerGit(root, nightlyTrigger);
    const scratch = new RunScratch();
    const originalCwd = process.cwd();
    try {
      process.chdir(nested);
      // No --dir: the toplevel, never the nearest `.e/` above the cwd.
      const out = triggered(root, git, scratch, { dir: undefined });
      assert.equal(out.store.checkoutRoot, root);
      assert.deepEqual(
        git.exports.map(e => e.dirPath),
        [eBaseDir(root)]
      );
    } finally {
      process.chdir(originalCwd);
      scratch.dispose();
    }
  });
});

test('--trigger: a --dir outside the repository is refused', () => {
  withStore(root => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'e-elsewhere-'));
    try {
      assert.throws(
        () =>
          triggered(root, triggerGit(root, nightlyTrigger), new RunScratch(), {
            dir: elsewhere,
          }),
        /is outside the repository/
      );
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

test('--trigger: a harness not committed at base is named, since e init on the runner cannot help', () => {
  withStore(root => {
    const git = new InMemoryGit({
      toplevel: root,
      defaultBranchRef: ORIGIN_MAIN,
      refCommits: { [ORIGIN_MAIN]: 'main-sha' },
      files: {
        [ORIGIN_MAIN]: {
          [triggerConfigPath('fix', root)]: JSON.stringify(nightlyTrigger),
        },
      },
    });
    const scratch = new RunScratch();
    try {
      const out = triggered(root, git, scratch);
      assert.throws(
        () => triggeredFacts(root, out),
        /Harness "claudeCode" is not in the Base Store: commit \.e\/harnesses\/claudeCode\/Dockerfile/
      );
    } finally {
      scratch.dispose();
    }
  });
});

/** An agent on the hosted Anthropic API, its key named in `.env` terms. */
const providerAgent = {
  name: 'claude-api',
  harness: 'claudeCode',
  provider: {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    protocol: 'anthropic-messages',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
};

test('--trigger: --env-file takes the place of .e/.env, filtered to the whitelist', () => {
  withStore(root => {
    // The checkout's `.e/.env` is the head's to write; it is never read.
    fs.writeFileSync(
      envFilePath(root),
      'ANTHROPIC_API_KEY=sk-head\nANTHROPIC_BASE_URL=https://attacker.example\n'
    );
    const envFile = path.join(root, 'ci.env');
    fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY=sk-ci\nDEPLOY_TOKEN=prod\n');
    const scratch = new RunScratch();
    try {
      const out = triggered(
        root,
        triggerGit(
          root,
          { ...nightlyTrigger, agent: 'claude-api' },
          { 'agents/claude-api/agent.json': JSON.stringify(providerAgent) }
        ),
        scratch,
        { envFile }
      );
      const facts = triggeredFacts(root, out, { envFile });
      assert.equal(facts.storeEnv.ANTHROPIC_API_KEY, 'sk-ci');
      assert.equal(facts.storeEnv.ANTHROPIC_BASE_URL, undefined);
      // Layered as the filtered base, never verbatim as a user env-file.
      assert.equal(facts.baseEnvFile, envFile);
      assert.equal(facts.userEnvFile, undefined);
      const plan = planSpawn(facts);
      const delivered = [
        filterEnvContent(
          fs.readFileSync(envFile, 'utf8'),
          plan.baseEnvWhitelist
        ),
        plan.providerEnvContent ?? '',
      ].join('\n');
      assert.match(delivered, /ANTHROPIC_API_KEY=sk-ci/);
      assert.doesNotMatch(delivered, /DEPLOY_TOKEN|sk-head|attacker/);
    } finally {
      scratch.dispose();
    }
  });
});

test('--trigger: an --env-file that does not exist is an error, not a run without secrets', () => {
  withStore(root => {
    const scratch = new RunScratch();
    try {
      const envFile = path.join(root, 'absent.env');
      const out = triggered(root, triggerGit(root, nightlyTrigger), scratch, {
        envFile,
      });
      assert.throws(
        () => triggeredFacts(root, out, { envFile }),
        /--env-file .*absent\.env does not exist/
      );
    } finally {
      scratch.dispose();
    }
  });
});

test('--trigger: a .e/.env committed at base exits 1 before any worktree', async () => {
  await withStoreAsync(async root => {
    const git = triggerGit(root, nightlyTrigger, {
      '.env': 'ANTHROPIC_API_KEY=sk-leaked\n',
    });
    const scratch = new RunScratch();
    const code = await runSpawnCommand(
      undefined,
      [],
      { dir: root, trigger: 'fix' },
      { scratch, git }
    );
    assert.equal(code, 1);
    assert.equal(git.worktrees.length, 0);
    // Nothing of the copy outlives the run, the committed secret included.
    assert.ok(!fs.existsSync(git.exports[0].dest));
  });
});

test('--trigger: a .e/.env committed only in the head is not read', () => {
  withStore(root => {
    fs.writeFileSync(envFilePath(root), 'ANTHROPIC_API_KEY=sk-head\n');
    const scratch = new RunScratch();
    try {
      const out = triggered(
        root,
        triggerGit(
          root,
          { ...nightlyTrigger, agent: 'claude-api' },
          { 'agents/claude-api/agent.json': JSON.stringify(providerAgent) },
          { [envFilePath(root)]: 'ANTHROPIC_API_KEY=sk-head\n' }
        ),
        scratch
      );
      const facts = triggeredFacts(root, out);
      assert.equal(facts.storeEnv.ANTHROPIC_API_KEY, undefined);
      assert.equal(facts.baseEnvFile, undefined);
    } finally {
      scratch.dispose();
    }
  });
});

test('--trigger: a sibling is handed the Base Store as --dir and the env file by marker, no --env-file', () => {
  withStore(root => {
    const envFile = path.join(root, 'ci.env');
    fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY=sk-ci\n');
    const scratch = new RunScratch();
    try {
      const out = triggered(root, triggerGit(root, nightlyTrigger), scratch, {
        envFile,
      });
      const facts = triggeredFacts(root, out, { envFile });
      assert.equal(facts.dirOpt, out.store.root);
      assert.equal(facts.storeEnvFile, envFile);
      assert.equal(facts.userEnvFile, undefined);
      assert.equal(facts.localStackPresent, false);

      // The sibling's own spawn: `--dir <Base Store>`, the marker, no trigger.
      process.env[Env.STORE_ENV_FILE_VAR] = envFile;
      writeAgent(out.store.root, providerAgent);
      const sibling = gatherSpawnFacts('claude-api', ['look into X'], {
        dir: out.store.root,
      });
      assert.equal(sibling.root, out.store.root);
      assert.equal(sibling.storeEnv.ANTHROPIC_API_KEY, 'sk-ci');
      assert.equal(sibling.baseEnvFile, envFile);
      assert.equal(sibling.storeEnvFile, envFile);
    } finally {
      delete process.env[Env.STORE_ENV_FILE_VAR];
      scratch.dispose();
    }
  });
});

test('E_STORE_ENV_FILE stands in for .e/.env in any spawn that carries it', () => {
  withStore(root => {
    writeAgent(root, providerAgent);
    fs.writeFileSync(envFilePath(root), 'ANTHROPIC_API_KEY=sk-store\n');
    const envFile = path.join(root, 'stand-in.env');
    fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY=sk-stand-in\n');
    process.env[Env.STORE_ENV_FILE_VAR] = envFile;
    const facts = gather(root, 'claude-api', ['x']);
    assert.equal(facts.storeEnv.ANTHROPIC_API_KEY, 'sk-stand-in');
    assert.equal(facts.baseEnvFile, envFile);
    fs.rmSync(envFile);
    assert.throws(
      () => gather(root, 'claude-api', ['x']),
      /E_STORE_ENV_FILE names .*stand-in\.env, which does not exist/
    );
  });
});
