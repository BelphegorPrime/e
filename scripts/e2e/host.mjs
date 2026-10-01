// Host facts and the build check shared by the tools that drive the real
// `e` CLI against real containers: the e2e tracer and the evaluation
// harness (scripts/eval).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** This repository's root, and the CLI the tools run. */
export const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);
export const CLI = path.join(REPO, 'dist', 'index.js');

/** The container engine, as `e` itself picks it up. */
export const ENGINE = process.env.E_RUNTIME ?? 'docker';

/** A synchronous child process, its output as text. */
export const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });

/** The host address containers on the default bridge reach the host at. */
export function bridgeGateway() {
  const r = sh(ENGINE, [
    'network',
    'inspect',
    'bridge',
    '-f',
    '{{(index .IPAM.Config 0).Gateway}}',
  ]);
  const ip = r.stdout?.trim();
  return r.status === 0 && ip ? ip : '172.17.0.1';
}

/** A port free on `host` right now. */
export function freePort(host) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, host, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Newest mtime under a directory, skipping generated and dependency dirs. */
function newestMtime(dir) {
  let newest = 0;
  const walk = d => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.endsWith('.generated.ts'))
        continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

/**
 * Rebuilds dist/ when src/ is newer than the compiled CLI (or dist is
 * missing); the build's output goes to `logFile`. Returns what it did, and
 * throws when the build fails.
 */
export function ensureBuild(logFile, force) {
  const stale =
    force ||
    !fs.existsSync(CLI) ||
    newestMtime(path.join(REPO, 'src')) > fs.statSync(CLI).mtimeMs;
  if (!stale) return 'up to date';
  process.stderr.write('building (npm run build:ts)...\n');
  const r = sh('npm', ['run', 'build:ts'], { cwd: REPO });
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, r.stdout + r.stderr);
  if (r.status !== 0) throw new Error(`build failed, see ${logFile}`);
  return 'rebuilt';
}

/** Runs git, or throws with its stderr. */
function gitOrThrow(cwd, ...args) {
  const r = sh('git', args, { cwd });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

/**
 * A sandbox Store at `dir/.e`, rendered by the CLI under test's own
 * `e init`: no compose.yaml, so a sandbox never touches the user's local
 * stack (its container names are global), no local runtimes, no PRs, and no
 * Agents - the defaults are named like the harnesses and would build
 * `e-agent-pi` & co over the user's real images. Returns the Store and its
 * config as written; throws when `e init` fails (its output is in
 * `dir/init.log`).
 */
export function initSandboxStore(dir) {
  const init = sh(process.execPath, [CLI, 'init', '-y', '--dir', dir], {
    cwd: dir,
    env: { ...process.env, NO_COLOR: '1' },
  });
  fs.writeFileSync(path.join(dir, 'init.log'), init.stdout + init.stderr);
  if (init.status !== 0) throw new Error(`e init failed, see ${dir}/init.log`);
  const store = path.join(dir, '.e');
  fs.rmSync(path.join(store, 'compose.yaml'), { force: true });
  const configFile = path.join(store, 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.localRuntimes = [];
  delete config.gitPlatform;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  fs.rmSync(path.join(store, 'agents'), { recursive: true, force: true });
  return { store, config };
}

/**
 * A repository at `repo` on `main` with one commit of `files` (a directory
 * copied in, or `{name: content}`), and a local bare origin at `origin` it
 * pushes to, so a run's pushes are observable.
 */
export function seedRepo(repo, origin, { files, user }) {
  fs.mkdirSync(repo, { recursive: true });
  if (typeof files === 'string') fs.cpSync(files, repo, { recursive: true });
  else {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(repo, name), content);
    }
  }
  gitOrThrow(path.dirname(origin), 'init', '-q', '--bare', origin);
  gitOrThrow(repo, 'init', '-q', '-b', 'main');
  gitOrThrow(repo, 'config', 'user.name', user);
  gitOrThrow(repo, 'config', 'user.email', `${user}@example.invalid`);
  gitOrThrow(repo, 'add', '-A');
  gitOrThrow(repo, 'commit', '-q', '-m', 'seed');
  gitOrThrow(repo, 'remote', 'add', 'origin', origin);
  gitOrThrow(repo, 'push', '-q', '-u', 'origin', 'main');
}
