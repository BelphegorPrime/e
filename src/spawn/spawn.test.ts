import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import {
  gatherSpawnFacts,
  registerSpawnCommand,
  type SpawnCommandOptions,
} from './spawn.js';
import { Env } from '../utils/env.js';
import {
  agentDir,
  configFilePath,
  eBaseDir,
  egressBlacklistPath,
  envFilePath,
  mcpDir,
  skillDir,
} from '../store/paths.js';

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
    assert.equal(facts.detached, false);
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
    assert.equal(facts.egressBlacklistFile, egressBlacklistPath(root));
    // The store's sibling settings ride along (defaults without a config.json).
    assert.deepEqual(facts.siblingArtifacts, ['node_modules']);
    assert.equal(facts.maxSiblings, 3);
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

test('--detached needs a prompt', () => {
  withStore(root => {
    assert.throws(
      () => gather(root, undefined, [], { detached: true }),
      /A prompt is required for detached runs\./
    );
    const facts = gather(root, 'go', [], { detached: true });
    assert.equal(facts.detached, true);
    assert.equal(facts.prompt, 'go');
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
  assert.equal(opts.detached, undefined);
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
    '-d',
    '--no-rm',
    '--keep-worktree',
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
  assert.equal(opts.detached, true);
  assert.equal(opts.rm, false);
  assert.equal(opts.keepWorktree, true);
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
