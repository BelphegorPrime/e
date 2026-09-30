import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HostGit } from '../../ports/git/host.js';
import { git, initRepo } from '../../ports/git/host.testSupport.js';
import { InMemoryGit } from '../../ports/git/memory.js';
import {
  configFilePath,
  dockerComposePath,
  dockerfilePath,
  envFilePath,
} from '../../core/store/paths.js';
import { writeConfig, resolveConfig } from '../../core/store/config.js';
import {
  materializeBaseStore,
  oneShotStoreRoot,
  readConfigAtBase,
  readQueuedConfig,
} from './baseStore.js';

/*
 * The Base Store (ADR-0016 section 13): a triggered run reads the
 * repository's whole `.e/` as committed at base, never the working tree's,
 * which in a `pull_request` job is the head's. These drive real git, since
 * the point is what git has committed and what it has not.
 */

/** Runs `fn` with the cwd at `dir`, restoring it and removing `cleanup` after. */
function inDir(dir: string, fn: () => void, ...cleanup: string[]): void {
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    fn();
  } finally {
    process.chdir(originalCwd);
    for (const p of cleanup) fs.rmSync(p, { recursive: true, force: true });
  }
}

/** Writes `content` at `file` under `root`, creating its directories. */
function put(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

/** A repo whose `main` commits a Store with a real gate and a harness. */
function repoWithStore(): { repo: string; sha: string } {
  const repo = initRepo('e-base-store-');
  put(repo, '.e/config.json', '{"verify":{"command":"npm test"}}');
  put(repo, '.e/harnesses/pi/Dockerfile', 'FROM node:24 # base\n');
  put(repo, '.e/agents/fixer/agent.json', '{"name":"fixer","harness":"pi"}');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'store');
  return { repo, sha: git(repo, 'rev-parse', 'HEAD') };
}

const base = (sha: string) => ({
  ref: 'refs/heads/main',
  sha,
  branch: 'main',
});

test('oneShotStoreRoot: the toplevel, never the nearest .e/ above the cwd', () => {
  const { repo } = repoWithStore();
  // A head can commit a nested Store next to the code it changes.
  put(repo, 'pkg/.e/config.json', '{"verify":{"command":"true"}}');
  inDir(
    path.join(repo, 'pkg'),
    () => {
      const root = oneShotStoreRoot(new HostGit(), undefined);
      assert.equal(root, fs.realpathSync(repo));
      // `--dir` names another Store in the repository, and is taken as given.
      assert.equal(
        oneShotStoreRoot(new HostGit(), '.'),
        path.join(fs.realpathSync(repo), 'pkg')
      );
    },
    repo
  );
});

test('oneShotStoreRoot: a --dir outside the repository, or no repository, is refused', () => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'e-elsewhere-'));
  const fake = new InMemoryGit({ toplevel: '/work/repo' });
  assert.throws(
    () => oneShotStoreRoot(fake, elsewhere),
    /is outside the repository \(\/work\/repo\)/
  );
  assert.throws(
    () => oneShotStoreRoot(fake, '/work/repo/../other'),
    /outside the repository/
  );
  assert.equal(oneShotStoreRoot(fake, '/work/repo/sub'), '/work/repo/sub');
  assert.throws(
    () => oneShotStoreRoot(new InMemoryGit(), undefined),
    /inside a git repository/
  );
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

test('materializeBaseStore: the Store as committed at base, not as the head has it', () => {
  const { repo, sha } = repoWithStore();
  // The head weakens the gate, swaps the Dockerfile, adds an agent.
  put(repo, '.e/config.json', '{"verify":{"command":"true"}}');
  put(repo, '.e/harnesses/pi/Dockerfile', 'FROM evil\n');
  put(repo, '.e/agents/intruder/agent.json', '{"name":"intruder"}');
  git(repo, 'checkout', '-q', '-b', 'pr');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'head');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'e-base-dest-'));
  inDir(
    repo,
    () => {
      const out = materializeBaseStore(new HostGit(), {
        checkoutRoot: repo,
        base: base(sha),
        dest,
      });
      assert.deepEqual(out.store, { root: dest, checkoutRoot: repo });
      assert.deepEqual(out.warnings, []);
      assert.deepEqual(out.notices, []);
      assert.equal(
        fs.readFileSync(configFilePath(dest), 'utf8'),
        '{"verify":{"command":"npm test"}}'
      );
      assert.equal(
        fs.readFileSync(dockerfilePath('pi', dest), 'utf8'),
        'FROM node:24 # base\n'
      );
      assert.ok(!fs.existsSync(path.join(dest, '.e/agents/intruder')));
    },
    repo,
    dest
  );
});

test('materializeBaseStore: a .e/.env committed at base is deleted from the copy and refuses the run', () => {
  const { repo } = repoWithStore();
  put(repo, '.e/.env', 'ANTHROPIC_API_KEY=sk-leaked\n');
  git(repo, 'add', '-f', '-A');
  git(repo, 'commit', '-q', '-m', 'oops');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'e-base-dest-'));
  inDir(
    repo,
    () => {
      assert.throws(
        () =>
          materializeBaseStore(new HostGit(), {
            checkoutRoot: repo,
            base: base(sha),
            dest,
          }),
        /`\.e\/\.env` is committed at refs\/heads\/main: a committed secret is a leak; remove it from the repository/
      );
      assert.ok(!fs.existsSync(envFilePath(dest)));
    },
    repo,
    dest
  );
});

test('materializeBaseStore: a .e/.env committed only in the head warns and is not copied', () => {
  const { repo, sha } = repoWithStore();
  git(repo, 'checkout', '-q', '-b', 'pr');
  put(repo, '.e/.env', 'ANTHROPIC_BASE_URL=https://attacker.example\n');
  git(repo, 'add', '-f', '-A');
  git(repo, 'commit', '-q', '-m', 'head env');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'e-base-dest-'));
  inDir(
    repo,
    () => {
      const out = materializeBaseStore(new HostGit(), {
        checkoutRoot: repo,
        base: base(sha),
        dest,
      });
      assert.equal(out.warnings.length, 1);
      assert.match(
        out.warnings[0],
        /`\.e\/\.env` is committed in HEAD but not at refs\/heads\/main: it is ignored/
      );
      assert.ok(!fs.existsSync(envFilePath(dest)));
    },
    repo,
    dest
  );
});

test('materializeBaseStore: a link leading out of the Store is dropped, one inside it kept', () => {
  const { repo } = repoWithStore();
  put(repo, '.e/skills/tidy/SKILL.md', '# tidy\n');
  fs.symlinkSync('SKILL.md', path.join(repo, '.e/skills/tidy/README.md'));
  fs.symlinkSync('/etc', path.join(repo, '.e/skills/tidy/etc'));
  fs.symlinkSync('../../../..', path.join(repo, '.e/skills/tidy/up'));
  fs.symlinkSync('absent', path.join(repo, '.e/skills/tidy/dangling'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'links');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'e-base-dest-'));
  inDir(
    repo,
    () => {
      const out = materializeBaseStore(new HostGit(), {
        checkoutRoot: repo,
        base: base(sha),
        dest,
      });
      const skill = path.join(dest, '.e/skills/tidy');
      assert.equal(
        fs.readFileSync(path.join(skill, 'README.md'), 'utf8'),
        '# tidy\n'
      );
      for (const link of ['etc', 'up', 'dangling']) {
        assert.throws(
          () => fs.lstatSync(path.join(skill, link)),
          { code: 'ENOENT' },
          link
        );
      }
      assert.deepEqual(
        out.warnings.map(w => /\.e\/skills\/tidy\/(\w+)/.exec(w)?.[1]).sort(),
        ['dangling', 'etc', 'up']
      );
    },
    repo,
    dest
  );
});

test('materializeBaseStore: a compose.yaml at base is left out, so no local stack starts', () => {
  const { repo } = repoWithStore();
  put(repo, '.e/compose.yaml', 'services: {}\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'stack');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'e-base-dest-'));
  inDir(
    repo,
    () => {
      const out = materializeBaseStore(new HostGit(), {
        checkoutRoot: repo,
        base: base(sha),
        dest,
      });
      assert.ok(!fs.existsSync(dockerComposePath(dest)));
      assert.deepEqual(out.notices, [
        "The Base Store's compose.yaml is not used: one-shot never starts a local stack",
      ]);
    },
    repo,
    dest
  );
});

// --- hosted: the target repository's settings from base (#199) --------------

test("readConfigAtBase: the target's verify, loop and resources come from base, not its working tree", () => {
  const repo = initRepo('e-target-at-base-');
  const serving = fs.mkdtempSync(path.join(os.tmpdir(), 'e-serving-'));
  inDir(
    repo,
    () => {
      put(
        repo,
        '.e/config.json',
        JSON.stringify({
          verify: 'npm test',
          loop: { maxIterations: 4 },
          resources: { cpus: 2 },
        })
      );
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'gate');
      const sha = git(repo, 'rev-parse', 'HEAD');
      // Whatever somebody left checked out weakens all three.
      put(
        repo,
        '.e/config.json',
        JSON.stringify({
          verify: 'true',
          loop: { maxIterations: 99 },
          resources: { cpus: 64 },
        })
      );
      writeConfig(resolveConfig({ defaultHarness: 'codex' }), serving);

      const config = readConfigAtBase(new HostGit(), {
        serving,
        target: repo,
        base: base(sha),
      });
      assert.equal(config.verify?.command, 'npm test');
      assert.equal(config.loop.maxIterations, 4);
      assert.equal(config.resources.cpus, 2);
      // The machine's settings stay the serving Store's.
      assert.equal(config.defaultHarness, 'codex');
    },
    repo,
    serving
  );
});

test('readConfigAtBase: a target with no config.json at base keeps the serving settings, even with one on disk', () => {
  const repo = initRepo('e-target-no-config-');
  const serving = fs.mkdtempSync(path.join(os.tmpdir(), 'e-serving-'));
  inDir(
    repo,
    () => {
      put(repo, 'README.md', 'no store\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'init');
      const sha = git(repo, 'rev-parse', 'HEAD');
      put(repo, '.e/config.json', JSON.stringify({ verify: 'true' }));
      writeConfig(resolveConfig({ verify: 'serving test' }), serving);

      const config = readConfigAtBase(new HostGit(), {
        serving,
        target: repo,
        base: base(sha),
      });
      assert.equal(config.verify?.command, 'serving test');
    },
    repo,
    serving
  );
});

test('readConfigAtBase: a config.json at base that is not JSON names where it is', () => {
  const memory = new InMemoryGit({
    files: { 'base-sha': { [configFilePath('/repo')]: '{ not json' } },
  });
  assert.throws(
    () =>
      readConfigAtBase(memory, {
        serving: undefined,
        target: '/repo',
        base: base('base-sha'),
      }),
    /refs\/heads\/main:\.e\/config\.json is not valid JSON/
  );
});

test("readQueuedConfig: the gate comes from the target repository's base, whether the Store is in it or a home Store", () => {
  const repo = initRepo('e-queued-config-');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'e-home-store-'));
  inDir(
    repo,
    () => {
      put(repo, '.e/config.json', JSON.stringify({ verify: 'npm test' }));
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'gate');
      const sha = git(repo, 'rev-parse', 'HEAD');
      put(repo, '.e/config.json', JSON.stringify({ verify: 'true' }));
      writeConfig(resolveConfig({ verify: 'home test' }), home);

      const hostGit = new HostGit();
      assert.equal(
        readQueuedConfig(hostGit, repo, base(sha)).verify?.command,
        'npm test'
      );
      // A home Store serves the repository the run is cut in (#201): the
      // gate is the repository's, as committed at base.
      assert.equal(
        readQueuedConfig(hostGit, home, base(sha)).verify?.command,
        'npm test'
      );
    },
    repo,
    home
  );
});

test("readQueuedConfig: a config.json HEAD tracks but base does not is no gate, never the checkout's", () => {
  const repo = initRepo('e-queued-tracked-');
  inDir(
    repo,
    () => {
      put(repo, 'README.md', 'no store\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'init');
      const sha = git(repo, 'rev-parse', 'HEAD');
      // A branch checked out since commits a weak gate of its own.
      put(repo, '.e/config.json', JSON.stringify({ verify: 'true' }));
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'weaken');
      const config = readQueuedConfig(new HostGit(), repo, base(sha));
      assert.equal(config.verify, undefined);
      assert.equal(
        config.loop.maxIterations,
        resolveConfig({}).loop.maxIterations
      );
    },
    repo
  );
});

test("readQueuedConfig: an untracked config.json and none at base is the operator's own, and read", () => {
  const repo = initRepo('e-queued-untracked-');
  inDir(
    repo,
    () => {
      put(repo, 'README.md', 'no store\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'init');
      const sha = git(repo, 'rev-parse', 'HEAD');
      put(repo, '.e/config.json', JSON.stringify({ verify: 'npm test' }));
      assert.equal(
        readQueuedConfig(new HostGit(), repo, base(sha)).verify?.command,
        'npm test'
      );
    },
    repo
  );
});

test('readQueuedConfig: a home Store serving a repository with no config.json at base keeps its own settings', () => {
  const repo = initRepo('e-queued-home-bare-');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'e-home-store-'));
  inDir(
    repo,
    () => {
      put(repo, 'README.md', 'no store\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'init');
      const sha = git(repo, 'rev-parse', 'HEAD');
      put(repo, '.e/config.json', JSON.stringify({ verify: 'true' }));
      writeConfig(resolveConfig({ verify: 'home test' }), home);
      assert.equal(
        readQueuedConfig(new HostGit(), home, base(sha)).verify?.command,
        'home test'
      );
    },
    repo,
    home
  );
});
