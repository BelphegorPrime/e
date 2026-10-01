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
  cliEnvValues,
  resolveTriggerSpawn,
  inheritedProvenance,
  runSpawnCommand,
  spawnCancelHandling,
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
  EGRESS_CONTAINER,
  OMNIROUTE_CONTAINER,
  OMNIROUTE_PORT,
} from '../shared/constants.js';
import { PinnedRuntime } from '../engine/runs/runSpawn.testSupport.js';
import {
  CANCEL_GRACE_MS,
  CANCELED_EXIT_CODE,
} from '../engine/runs/runSpawn.js';
import { fakeOmniRoute } from '../engine/spawn/omniRoute.testSupport.js';
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
  Env.ONE_SHOT_VAR,
  Env.LEDGER_FILE_VAR,
  Env.SPAWN_REPORT_SPOOL_VAR,
  Env.SPAWN_REPORT_ID_VAR,
  Env.SPAWN_FUSION_VAR,
  Env.SPAWN_FUSION_BASE_SHA_VAR,
  Env.SPAWN_FUSION_BASE_REF_VAR,
  Env.SPAWN_FUSION_BASE_BRANCH_VAR,
  Env.SPAWN_FUSION_SYNTHESIS_VAR,
  Env.SPAWN_FUSION_MATERIAL_VAR,
  Env.TRIGGER_VAR,
  Env.EVENT_VAR,
  Env.EVENT_URL_VAR,
  Env.GITHUB_WORKFLOW_VAR,
  Env.GITHUB_RUN_ID_VAR,
  Env.GITHUB_SERVER_URL_VAR,
  Env.GITHUB_REPOSITORY_VAR,
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

test('a home Store spans its run namespace over every repository its triggers name', () => {
  withStore(root => {
    fs.mkdirSync(path.dirname(triggerConfigPath('nightly', root)), {
      recursive: true,
    });
    fs.writeFileSync(
      triggerConfigPath('nightly', root),
      JSON.stringify({
        agent: 'pi',
        prompt: 'p',
        repo: '/src/other',
        on: { type: 'cron', expr: '0 3 * * *' },
      })
    );
    // A repo-local Store ignores `repo`: its runs are its own repository's.
    assert.deepEqual(gather(root, undefined, []).runNamespace, []);
    const home = process.env.HOME;
    process.env.HOME = root;
    try {
      assert.deepEqual(gather(root, undefined, []).runNamespace, [
        path.resolve('/src/other'),
      ]);
    } finally {
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
    }
  });
});

test('the provider policy and every env layer the container receives reach validateSpawn', () => {
  withStore(root => {
    assert.equal(gather(root, 'pi', ['hi']).providerPolicy, undefined);
    fs.writeFileSync(
      configFilePath(root),
      JSON.stringify({ providers: { deny: ['gw.example'] } })
    );
    const envFile = path.join(root, 'extra.env');
    fs.writeFileSync(envFile, 'OPENAI_BASE_URL=https://gw.example/v1\n');
    const facts = gather(root, 'pi', ['hi'], {
      envFile,
      env: ['ANTHROPIC_BASE_URL=http://other.example'],
    });
    assert.deepEqual(facts.providerPolicy, { deny: ['gw.example'] });
    assert.deepEqual(facts.containerEnvLayers, [
      { OPENAI_BASE_URL: 'https://gw.example/v1' },
      { ANTHROPIC_BASE_URL: 'http://other.example' },
    ]);
    // pi has no provider here: the --env-file's base URL is where it sends.
    assert.throws(
      () => validateSpawn(facts),
      /agent "pi" sends to gw\.example: denied by "gw\.example"/
    );
  });
});

test('cliEnvValues: K=V as given, a bare K as the host value the engine passes', () => {
  process.env.E_TEST_PASSED = 'from-host';
  try {
    assert.deepEqual(
      cliEnvValues(['A=1', 'B=x=y', 'E_TEST_PASSED', 'UNSET_X']),
      {
        A: '1',
        B: 'x=y',
        E_TEST_PASSED: 'from-host',
      }
    );
  } finally {
    delete process.env.E_TEST_PASSED;
  }
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
    '--mcp',
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

test('spawn CLI: a repeatable option takes one value, so a prompt after it stays the prompt', async () => {
  // Regression: `--skill <name...>` was variadic and read the prompt as a
  // second skill name ("Unknown skill \"<prompt>\"").
  const { target, prompt, opts } = await parseSpawn([
    'demo',
    '--skill',
    'spawn-brother',
    'split the work',
    '--mcp',
    'everything',
    'and',
    '-e',
    'X=1',
    'integrate',
    '-p',
    '8080:80',
    'it',
  ]);
  assert.equal(target, 'demo');
  assert.deepEqual(prompt, ['split the work', 'and', 'integrate', 'it']);
  assert.deepEqual(opts.skill, ['spawn-brother']);
  assert.deepEqual(opts.mcp, ['everything']);
  assert.deepEqual(opts.env, ['X=1']);
  assert.deepEqual(opts.port, ['8080:80']);
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

test("resolveRemoteTarget: the provider policy is checked against the remote agent's URL", () => {
  withStore(root => {
    writeAgent(root, {
      name: 'remote',
      transport: 'a2a',
      url: 'https://agents.example.com/a2a',
    });
    fs.writeFileSync(
      configFilePath(root),
      JSON.stringify({ providers: { allow: ['localhost'] } })
    );
    assert.throws(
      () => resolveRemoteTarget('remote', ['hi'], { dir: root }),
      /agent "remote" sends to agents\.example\.com: not in the allow list/
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
      const { store, provenance, ...rest } = out;
      assert.equal(provenance.trigger, 'fix');
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

test('--trigger: a one-shot run in GitHub Actions is provenanced by its workflow run, and the facts carry it', () => {
  withStore(root => {
    process.env[Env.GITHUB_WORKFLOW_VAR] = 'Nightly agent';
    process.env[Env.GITHUB_RUN_ID_VAR] = '10987654321';
    process.env[Env.GITHUB_SERVER_URL_VAR] = 'https://github.com';
    process.env[Env.GITHUB_REPOSITORY_VAR] = 'octo/repo';
    const scratch = new RunScratch();
    try {
      const out = triggered(root, triggerGit(root, nightlyTrigger), scratch);
      const expected = {
        trigger: 'fix',
        event: {
          source: 'workflow',
          event: 'Nightly-agent',
          id: '10987654321',
        },
        url: 'https://github.com/octo/repo/actions/runs/10987654321',
      };
      assert.deepEqual(out.provenance, expected);
      assert.deepEqual(triggeredFacts(root, out).provenance, expected);
    } finally {
      scratch.dispose();
    }
  });
});

test('--trigger: a run id that would forge a trailer is replaced by a fresh ULID at the one-shot edge', () => {
  withStore(root => {
    process.env[Env.GITHUB_RUN_ID_VAR] = '1\nE-Trigger: forged';
    const scratch = new RunScratch();
    try {
      const out = triggered(root, triggerGit(root, nightlyTrigger), scratch);
      assert.equal(out.provenance.event.event, 'one-shot');
      assert.match(out.provenance.event.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.equal(out.provenance.url, undefined);
    } finally {
      scratch.dispose();
    }
  });
});

test('a manual spawn carries no provenance, even with stale markers in the shell', () => {
  withStore(root => {
    process.env[Env.TRIGGER_VAR] = 'nightly';
    process.env[Env.EVENT_VAR] = 'cron:tick:20260918T0300Z';
    assert.equal(inheritedProvenance(), undefined);
    assert.equal(gather(root, 'claudeCode', ['x']).provenance, undefined);
  });
});

test("a queued run's spawn cuts from the base serve resolved at claim; a manual spawn from where it stands", () => {
  withStore(root => {
    const live = path.join(root, '.e', 'runs', 'live');
    fs.mkdirSync(live, { recursive: true });
    const file = path.join(live, 'trg-x.json');
    const base = {
      ref: 'refs/remotes/origin/main',
      sha: 'abc1234',
      branch: 'main',
    };
    fs.writeFileSync(
      file,
      JSON.stringify({
        id: 'trg-x',
        state: 'claimed',
        slot: true,
        agent: 'claudeCode',
        run: null,
        base,
      })
    );
    assert.equal(gather(root, 'claudeCode', ['x']).base, undefined);
    process.env[Env.LEDGER_FILE_VAR] = file;
    try {
      assert.deepEqual(gather(root, 'claudeCode', ['x']).base, base);
      // A torn base never falls back to the checkout.
      fs.writeFileSync(
        file,
        JSON.stringify({
          id: 'trg-x',
          state: 'claimed',
          slot: true,
          agent: 'claudeCode',
          run: null,
          base: { ref: 'refs/remotes/origin/main' },
        })
      );
      assert.throws(
        () => gather(root, 'claudeCode', ['x']),
        /base that is not whole/
      );
    } finally {
      delete process.env[Env.LEDGER_FILE_VAR];
    }
  });
});

test("a queued run's gate and caps come from its base, not from the checkout's config.json (#199)", () => {
  withStore(root => {
    const live = path.join(root, '.e', 'runs', 'live');
    fs.mkdirSync(live, { recursive: true });
    const file = path.join(live, 'trg-x.json');
    const base = { ref: ORIGIN_MAIN, sha: 'main-sha', branch: 'main' };
    fs.writeFileSync(
      file,
      JSON.stringify({
        id: 'trg-x',
        state: 'claimed',
        slot: true,
        agent: 'claudeCode',
        run: null,
        base,
      })
    );
    // Whatever somebody left checked out, with a machine setting beside it.
    fs.writeFileSync(
      configFilePath(root),
      JSON.stringify({
        verify: 'true',
        loop: { maxIterations: 99 },
        siblingArtifacts: ['vendor'],
      })
    );
    const git = new InMemoryGit({
      toplevel: root,
      files: {
        'main-sha': {
          [configFilePath(root)]: JSON.stringify({
            verify: 'npm test',
            loop: { maxIterations: 3 },
          }),
        },
      },
    });
    process.env[Env.LEDGER_FILE_VAR] = file;
    try {
      const facts = gatherSpawnFacts(
        'claudeCode',
        ['x'],
        { dir: root },
        undefined,
        git
      );
      assert.equal(facts.verify?.command, 'npm test');
      assert.equal(facts.loop?.maxIterations, 3);
      // The machine's settings stay the serving Store's.
      assert.deepEqual(facts.siblingArtifacts, ['vendor']);
    } finally {
      delete process.env[Env.LEDGER_FILE_VAR];
    }
    // A manual spawn reads the checkout, as always.
    const manual = gatherSpawnFacts(
      'claudeCode',
      ['x'],
      { dir: root },
      undefined,
      git
    );
    assert.equal(manual.verify?.command, 'true');
  });
});

test("gatherSpawnFacts: a fusion candidate cuts from its fusion's base and reads the checkout's config", () => {
  withStore(root => {
    fs.writeFileSync(
      configFilePath(root),
      JSON.stringify({ verify: 'npm test' })
    );
    process.env[Env.SPAWN_REPORT_SPOOL_VAR] = '/wt/.fusion/f';
    process.env[Env.SPAWN_REPORT_ID_VAR] = 'cand-001';
    process.env[Env.SPAWN_FUSION_VAR] = 'fusion-X';
    process.env[Env.SPAWN_FUSION_BASE_SHA_VAR] = 'pinned-sha';
    process.env[Env.SPAWN_FUSION_BASE_REF_VAR] = 'refs/heads/main';
    process.env[Env.SPAWN_FUSION_BASE_BRANCH_VAR] = 'main';
    const facts = gather(root, 'claudeCode', ['x']);
    const pinned = {
      sha: 'pinned-sha',
      ref: 'refs/heads/main',
      branch: 'main',
    };
    assert.deepEqual(facts.base, pinned);
    assert.deepEqual(facts.fusionCandidate, {
      fusion: 'fusion-X',
      base: pinned,
    });
    assert.deepEqual(facts.report, {
      spoolDir: '/wt/.fusion/f',
      id: 'cand-001',
    });
    assert.equal(facts.verify?.command, 'npm test');
    // A queued run is somebody else's; a candidate is only ever its fusion's.
    process.env[Env.LEDGER_FILE_VAR] = '/s/.e/runs/live/trg-x.json';
    assert.throws(
      () => gather(root, 'claudeCode', ['x']),
      /fusion candidate of fusion-X is started by its fusion, never by a trigger or the queue/
    );
  });
});

test("gatherSpawnFacts: a fusion synthesis reads its material's summary, and refuses one that is not an identifier", () => {
  withStore(root => {
    const material = path.join(root, 'material');
    fs.mkdirSync(material);
    const summary = {
      schemaVersion: 1,
      fusion: 'fusion-01K6ZQ4W0R1X2Y3Z4A5B6C7D8E',
      profile: 'coding',
      synthesizer: 'claudeCode',
      base: { sha: 'abc1234', branch: 'main' },
      task: 'Add retries',
      candidates: [],
    };
    fs.writeFileSync(
      path.join(material, 'fusion.json'),
      JSON.stringify(summary)
    );
    process.env[Env.SPAWN_REPORT_SPOOL_VAR] = '/wt/.fusion/f';
    process.env[Env.SPAWN_REPORT_ID_VAR] = 'syn-001';
    process.env[Env.SPAWN_FUSION_SYNTHESIS_VAR] = summary.fusion;
    process.env[Env.SPAWN_FUSION_MATERIAL_VAR] = material;
    process.env[Env.SPAWN_FUSION_BASE_SHA_VAR] = 'abc1234';
    process.env[Env.SPAWN_FUSION_BASE_REF_VAR] = 'refs/heads/main';
    process.env[Env.SPAWN_FUSION_BASE_BRANCH_VAR] = 'main';
    const facts = gather(root, 'claudeCode', ['x']);
    assert.equal(facts.base?.sha, 'abc1234');
    assert.deepEqual(facts.fusionSynthesis?.summary, summary);
    assert.equal(facts.fusionSynthesis?.material, material);
    assert.equal(facts.fusionCandidate, undefined);
    fs.writeFileSync(
      path.join(material, 'fusion.json'),
      JSON.stringify({ ...summary, synthesizer: '@everyone' })
    );
    assert.throws(
      () => gather(root, 'claudeCode', ['x']),
      /Invalid fusion material at .*"synthesizer"/
    );
    fs.rmSync(path.join(material, 'fusion.json'));
    assert.throws(
      () => gather(root, 'claudeCode', ['x']),
      /Cannot read the fusion material/
    );
  });
});

test("a queued run's spawn and a sibling's read the provenance their host handed them", () => {
  process.env[Env.TRIGGER_VAR] = 'nightly';
  process.env[Env.EVENT_VAR] = 'github:issues.labeled:d-1';
  process.env[Env.EVENT_URL_VAR] = 'https://github.com/octo/repo/issues/42';
  process.env[Env.LEDGER_FILE_VAR] = '/s/.e/runs/live/trg-x.json';
  const expected = {
    trigger: 'nightly',
    event: { source: 'github', event: 'issues.labeled', id: 'd-1' },
    url: 'https://github.com/octo/repo/issues/42',
  };
  assert.deepEqual(inheritedProvenance(), expected);
  delete process.env[Env.LEDGER_FILE_VAR];
  process.env[Env.SPAWN_PARENT_WORKTREE_VAR] = '/wt/parent';
  process.env[Env.SPAWN_PARENT_BRANCH_VAR] = 'e/demo/parent-1';
  process.env[Env.SPAWN_SPOOL_VAR] = '/wt/.broker/p';
  process.env[Env.SPAWN_SIBLING_ID_VAR] = 'sib-001';
  assert.deepEqual(inheritedProvenance(), expected);
  // A broken handover fails the run rather than write a trailer nobody vouched for.
  process.env[Env.EVENT_VAR] = 'github:issues';
  assert.throws(() => inheritedProvenance(), /Malformed provenance/);
});

// --- one-shot on a host with a running stack (#200) --------------------------

const localAgent = {
  name: 'local',
  harness: 'claudeCode',
  provider: {
    baseUrl: `http://127.0.0.1:${OMNIROUTE_PORT}/v1`,
    model: 'qwen3-coder',
    protocol: 'anthropic-messages',
    apiKeyEnv: 'OMNI_KEY',
  },
};

test('--trigger with a running stack: the run key is minted before the container and deleted after a red run', async () => {
  await withStoreAsync(async root => {
    process.env[Env.WORKTREES_DIR_VAR] = path.join(root, 'wt');
    const envFile = path.join(root, 'runner.env');
    fs.writeFileSync(envFile, 'OMNIROUTE_INITIAL_PASSWORD=pw\n');
    const omni = fakeOmniRoute({ password: 'pw' });
    const runtime = new PinnedRuntime(1);
    let keysDuringRun: string[] = [];
    runtime.onRun = () => {
      keysDuringRun = omni.keys.map(k => k.name);
    };
    const code = await runSpawnCommand(
      undefined,
      [],
      { dir: root, trigger: 'fix', envFile },
      {
        scratch: new RunScratch(),
        git: triggerGit(
          root,
          { ...nightlyTrigger, agent: 'local' },
          { 'agents/local/agent.json': JSON.stringify(localAgent) }
        ),
        runtime,
        fetchImpl: omni.fetchImpl,
      }
    );
    assert.notEqual(code, 0);
    assert.equal(keysDuringRun.length, 1);
    assert.match(keysDuringRun[0], /^e-run-fix-[0-9A-Z]{26}$/);
    assert.deepEqual(omni.keys, [], 'deleted after teardown');
    // Used, never started; the run joined the egress namespace.
    assert.deepEqual(runtime.composedUp, []);
    assert.equal(runtime.runs[0].options.netns, EGRESS_CONTAINER);
  });
});

test('--trigger with a running stack: an aborted run still deletes its key', async () => {
  await withStoreAsync(async root => {
    process.env[Env.WORKTREES_DIR_VAR] = path.join(root, 'wt');
    const envFile = path.join(root, 'runner.env');
    fs.writeFileSync(envFile, 'OMNIROUTE_INITIAL_PASSWORD=pw\n');
    const omni = fakeOmniRoute({ password: 'pw' });
    const runtime = new PinnedRuntime(0);
    const cancel = new AbortController();
    // The scheduler cancels while the agent runs.
    runtime.onRun = () => cancel.abort();
    await runSpawnCommand(
      undefined,
      [],
      { dir: root, trigger: 'fix', envFile },
      {
        scratch: new RunScratch(),
        git: triggerGit(
          root,
          { ...nightlyTrigger, agent: 'local' },
          { 'agents/local/agent.json': JSON.stringify(localAgent) }
        ),
        runtime,
        abort: cancel.signal,
        fetchImpl: omni.fetchImpl,
      }
    );
    assert.equal(runtime.ran, true);
    assert.equal(
      omni.calls.filter(c => c.method === 'POST' && c.path === '/api/keys')
        .length,
      1
    );
    assert.deepEqual(omni.keys, []);
  });
});

test('--trigger with a running stack and no password in --env-file: exit 1, nothing prompts, no container', async () => {
  await withStoreAsync(async root => {
    process.env[Env.WORKTREES_DIR_VAR] = path.join(root, 'wt');
    const envFile = path.join(root, 'runner.env');
    fs.writeFileSync(envFile, 'OMNI_KEY=sk-whatever\n');
    const omni = fakeOmniRoute({ password: 'pw' });
    const runtime = new PinnedRuntime(0);
    const code = await runSpawnCommand(
      undefined,
      [],
      { dir: root, trigger: 'fix', envFile },
      {
        scratch: new RunScratch(),
        git: triggerGit(
          root,
          { ...nightlyTrigger, agent: 'local' },
          { 'agents/local/agent.json': JSON.stringify(localAgent) }
        ),
        runtime,
        fetchImpl: omni.fetchImpl,
      }
    );
    assert.equal(code, 1);
    assert.equal(runtime.ran, false);
    assert.deepEqual(omni.calls, []);
  });
});

test('--trigger without a running stack: no netns, no key, no composeUp', async () => {
  await withStoreAsync(async root => {
    process.env[Env.WORKTREES_DIR_VAR] = path.join(root, 'wt');
    const omni = fakeOmniRoute({ password: 'pw' });
    const runtime = new PinnedRuntime(0);
    runtime.crashed = new Set([EGRESS_CONTAINER, OMNIROUTE_CONTAINER]);
    const code = await runSpawnCommand(
      undefined,
      [],
      { dir: root, trigger: 'fix' },
      {
        scratch: new RunScratch(),
        git: triggerGit(root, nightlyTrigger),
        runtime,
        fetchImpl: omni.fetchImpl,
      }
    );
    assert.equal(code, 0);
    assert.equal(runtime.runs[0].options.netns, undefined);
    assert.deepEqual(runtime.composedUp, []);
    assert.deepEqual(omni.calls, []);
  });
});

test('gatherSpawnFacts: E_ONE_SHOT marks a sibling one-shot, and only a sibling', () => {
  withStore(root => {
    process.env[Env.ONE_SHOT_VAR] = '1';
    assert.equal(
      gatherSpawnFacts('claudeCode', ['hi'], { dir: root }).oneShotShape,
      false,
      'a stale export alone changes nothing'
    );
  });
});

test('spawnCancelHandling: the first signal cancels; later ones wait; a spent grace drops the secrets, then exits', () => {
  // Regression: a Ctrl-C had no handler, so it killed `e` wherever it was -
  // mid-teardown included - and left the worktree and the rendered secret
  // files behind.
  const cancel = new AbortController();
  const warned: string[] = [];
  const events: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const onSignal = spawnCancelHandling({
    cancel,
    warn: text => warned.push(text),
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    dispose: () => events.push('dispose'),
    exit: code => events.push(`exit ${code}`),
  });

  onSignal();
  assert.equal(cancel.signal.aborted, true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, CANCEL_GRACE_MS);
  assert.match(warned[0], /Canceling the run/);

  // A second Ctrl-C is acknowledged, never a hard exit, never a second timer.
  onSignal();
  onSignal();
  assert.equal(timers.length, 1);
  assert.deepEqual(events, []);
  assert.match(warned[1], /Still canceling/);

  timers[0].fn();
  assert.deepEqual(events, ['dispose', `exit ${CANCELED_EXIT_CODE}`]);
});
