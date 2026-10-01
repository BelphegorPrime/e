#!/usr/bin/env node
// End-to-end tracer for `e`: builds the CLI, runs real `e` commands against a
// disposable sandbox (own Store, own git repo with a local bare origin, own
// worktrees dir) and records every aspect of the execution so an agent can
// check a feature works: e's stdout/stderr, every container engine event, each
// container's inspect and logs, every model request and reply (scripted stub
// or a recording proxy to the local OmniRoute), git before/after, the Store's
// run records, and leaks. See docs/agents/e2e.md.
//
//   node scripts/e2e/e2e.mjs new [name] [--model stub|live]
//   node scripts/e2e/e2e.mjs run <name> [--script f.json | --turns '<json>'] [--tee] -- spawn e2e-pi "task"
//   node scripts/e2e/e2e.mjs run <name> --tui keys.json [--size 120x40] -- spawn e2e-pi   (drive a TUI)
//   node scripts/e2e/e2e.mjs report <name>
//   node scripts/e2e/e2e.mjs list
//   node scripts/e2e/e2e.mjs clean <name> [--images]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  findLeaks,
  foldEvents,
  interestingLines,
  redactInspect,
  renderSummary,
  stepSlug,
  summarizeModelLog,
  tailLines,
} from './lib.mjs';
import { parseKeys, runTui } from './tui.mjs';
import {
  CLI,
  ENGINE,
  REPO,
  bridgeGateway,
  ensureBuild as ensureBuildOf,
  freePort,
  initSandboxStore,
  seedRepo,
  sh,
} from './host.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.join(REPO, '.e2e');
const OMNIROUTE = process.env.OMNIROUTE_URL ?? 'http://127.0.0.1:20128';

/** Agents every sandbox gets; names are e2e-* so their images never collide. */
const AGENTS = [
  { name: 'e2e-pi', harness: 'pi', protocol: 'openai-chat', v1: true },
  {
    name: 'e2e-codex',
    harness: 'codex',
    protocol: 'openai-responses',
    v1: true,
  },
  {
    name: 'e2e-opencode',
    harness: 'opencode',
    protocol: 'openai-chat',
    v1: true,
  },
  // A model id Claude Code's catalog knows, so it does not warn on every run.
  {
    name: 'e2e-claude',
    harness: 'claudeCode',
    protocol: 'anthropic-messages',
    v1: false,
    stubModel: 'claude-sonnet-4-5',
  },
];

const die = msg => {
  process.stderr.write(`e2e: ${msg}\n`);
  process.exit(2);
};

const git = (cwd, ...args) => {
  const r = sh('git', args, { cwd });
  return r.status === 0
    ? r.stdout
    : `(git ${args.join(' ')} failed: ${r.stderr.trim()})\n`;
};

/** Rebuilds dist/ when it is stale; a failed build ends the tracer. */
function ensureBuild(logFile, force) {
  try {
    return ensureBuildOf(logFile, force);
  } catch (err) {
    die(err.message);
  }
}

function sandboxDir(root, name) {
  return path.join(root, name);
}

function readSandbox(root, name) {
  if (!name) die('missing sandbox name (see `e2e.mjs list`)');
  const file = path.join(sandboxDir(root, name), 'sandbox.json');
  if (!fs.existsSync(file)) die(`no sandbox ${name} under ${root}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

// ---------------------------------------------------------------- new

async function cmdNew(positionals, values) {
  const root = path.resolve(values.root ?? DEFAULT_ROOT);
  const name =
    positionals[0] ??
    `sb-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  const model = values.model ?? 'stub';
  if (!['stub', 'live'].includes(model)) die('--model is stub or live');
  const dir = sandboxDir(root, name);
  if (fs.existsSync(dir)) {
    if (!values.force) die(`${dir} exists (pass --force to replace it)`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  ensureBuild(path.join(dir, 'build.log'), false);

  let store;
  try {
    ({ store } = initSandboxStore(dir));
  } catch (err) {
    die(err.message);
  }

  const host = bridgeGateway();
  const port = await freePort(host);
  const modelId =
    model === 'live' ? (values['live-model'] ?? 'auto/coding') : 'stub';
  for (const a of AGENTS) {
    writeJson(path.join(store, 'agents', a.name, 'agent.json'), {
      name: a.name,
      harness: a.harness,
      provider: {
        baseUrl: `http://${host}:${port}${a.v1 ? '/v1' : ''}`,
        model: model === 'stub' ? (a.stubModel ?? modelId) : modelId,
        protocol: a.protocol,
        apiKeyEnv: 'E2E_MODEL_KEY',
      },
    });
  }
  let key = 'e2e-stub-key';
  if (model === 'live') {
    const homeEnv = path.join(os.homedir(), '.e', '.env');
    const m = fs.existsSync(homeEnv)
      ? fs.readFileSync(homeEnv, 'utf8').match(/^OPENAI_API_KEY=(.+)$/m)
      : null;
    if (m) key = m[1].trim();
  }
  fs.appendFileSync(path.join(store, '.env'), `\nE2E_MODEL_KEY=${key}\n`);

  // The repo e runs in, with a local bare origin so pushes are observable.
  const repo = path.join(dir, 'repo');
  const origin = path.join(dir, 'origin.git');
  seedRepo(repo, origin, {
    user: 'e2e',
    files: {
      'README.md': '# e2e sandbox repo\n',
      '.gitignore': 'node_modules\n.env\n',
    },
  });
  fs.mkdirSync(path.join(dir, 'worktrees'));
  fs.mkdirSync(path.join(dir, 'steps'));

  const sb = {
    name,
    dir,
    created: new Date().toISOString(),
    model,
    modelId,
    upstream: model === 'live' ? OMNIROUTE : undefined,
    host,
    port,
    store,
    repo,
    origin,
    worktrees: path.join(dir, 'worktrees'),
    agents: AGENTS.map(a => a.name),
  };
  writeJson(path.join(dir, 'sandbox.json'), sb);
  process.stdout.write(
    [
      `sandbox ${name} ready: ${dir}`,
      `  store ${store} (agents: ${sb.agents.join(', ')})`,
      `  repo  ${repo} (origin ${origin})`,
      `  model ${model}${sb.upstream ? ` -> ${sb.upstream}` : ''} at http://${host}:${port}`,
      `next: node scripts/e2e/e2e.mjs run ${name} --turns '[{"tool":"bash","args":{"command":"echo hi > hi.txt"}}]' -- spawn e2e-pi "write hi.txt"`,
      '',
    ].join('\n')
  );
}

// ---------------------------------------------------------------- run

function startStub(sb, stepDir, scriptFile) {
  const args = [
    path.join(HERE, 'stub-model.mjs'),
    '--port',
    String(sb.port),
    '--host',
    sb.host,
    '--log',
    path.join(stepDir, 'model.jsonl'),
  ];
  if (sb.upstream) args.push('--upstream', sb.upstream);
  else if (scriptFile) args.push('--script', scriptFile);
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.stdout.once('data', () => resolve(child));
    child.once('exit', code => reject(new Error(`stub model exited ${code}`)));
  });
}

/** Streams engine events into a file and follows each new container's logs. */
function startEventWatch(stepDir) {
  const file = path.join(stepDir, 'docker-events.jsonl');
  const containersDir = path.join(stepDir, 'containers');
  fs.mkdirSync(containersDir, { recursive: true });
  const out = fs.createWriteStream(file);
  const followers = [];
  const names = new Map();
  const child = spawn(ENGINE, ['events', '--format', '{{json .}}'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  child.stdout.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      out.write(line + '\n');
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if ((ev.Type ?? ev.type) !== 'container') continue;
      const id = ev.Actor?.ID ?? ev.id;
      const name = ev.Actor?.Attributes?.name ?? id.slice(0, 12);
      names.set(id, name);
      const action = (ev.Action ?? ev.status ?? '').split(':')[0];
      if (action === 'create') {
        const r = sh(ENGINE, ['inspect', id]);
        if (r.status === 0) {
          try {
            writeJson(
              path.join(containersDir, `${name}.inspect.json`),
              redactInspect(JSON.parse(r.stdout)[0])
            );
          } catch {
            /* unparseable inspect: skip */
          }
        }
      }
      if (action === 'start') {
        const log = fs.openSync(path.join(containersDir, `${name}.log`), 'a');
        const f = spawn(ENGINE, ['logs', '-f', '--timestamps', id], {
          stdio: ['ignore', log, log],
        });
        followers.push(f);
      }
    }
  });
  return {
    stop: () =>
      new Promise(resolve => {
        for (const f of followers) if (f.exitCode === null) f.kill('SIGTERM');
        child.kill('SIGTERM');
        child.once('exit', () => out.end(resolve));
      }),
  };
}

/**
 * Mirrors the broker spools under the worktrees dir into the step while the
 * command runs: a sibling's own `e spawn` logs there, and the host removes the
 * spool when the parent run ends.
 */
function startSpoolMirror(sb, stepDir) {
  const src = path.join(sb.worktrees, '.broker');
  const dest = path.join(stepDir, 'spool');
  const seen = new Map();
  const copy = () => {
    const walk = d => {
      let ents;
      try {
        ents = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of ents) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.isFile()) {
          try {
            const st = fs.statSync(p);
            const key = `${st.size}:${st.mtimeMs}`;
            if (seen.get(p) === key) continue;
            seen.set(p, key);
            const to = path.join(dest, path.relative(src, p));
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.copyFileSync(p, to);
          } catch {
            /* removed under us: the last copy stands */
          }
        }
      }
    };
    walk(src);
  };
  const timer = setInterval(copy, 500);
  return {
    stop: () => {
      clearInterval(timer);
      copy();
    },
  };
}

function branchShas(repo) {
  const out = git(
    repo,
    'for-each-ref',
    '--format=%(refname:short) %(objectname)',
    'refs/heads'
  );
  return new Map(
    out
      .split('\n')
      .filter(Boolean)
      .map(l => l.split(' '))
  );
}

function collectGit(sb, stepDir, before, base) {
  const gdir = path.join(stepDir, 'git');
  fs.mkdirSync(path.join(gdir, 'diffs'), { recursive: true });
  const graph = git(
    sb.repo,
    'log',
    '--all',
    '--graph',
    '--oneline',
    '--decorate',
    '-n',
    '60'
  );
  const remote = git(sb.repo, 'ls-remote', 'origin');
  fs.writeFileSync(path.join(gdir, 'graph.txt'), graph);
  fs.writeFileSync(
    path.join(gdir, 'branches.txt'),
    git(sb.repo, 'branch', '-a', '-vv')
  );
  fs.writeFileSync(
    path.join(gdir, 'worktrees.txt'),
    git(sb.repo, 'worktree', 'list', '--porcelain')
  );
  fs.writeFileSync(path.join(gdir, 'remote.txt'), remote);
  const status = git(sb.repo, 'status', '--porcelain');
  fs.writeFileSync(path.join(gdir, 'checkout-status.txt'), status);
  const after = branchShas(sb.repo);
  const newBranches = [];
  for (const [name, sha] of after) {
    if (before.get(name) === sha) continue;
    const file = name.replace(/[^A-Za-z0-9._-]+/g, '_') + '.diff';
    const range = `${base}...${name}`;
    const stat = git(sb.repo, 'diff', '--stat', range);
    fs.writeFileSync(
      path.join(gdir, 'diffs', file),
      git(sb.repo, 'log', '--format=fuller', `${base}..${name}`) +
        '\n' +
        git(sb.repo, 'diff', range)
    );
    newBranches.push({ name, sha, stat, file });
  }
  return { graph, remote, newBranches, checkoutDirty: status.trim() };
}

/** Lists the Store's run records and copies the small ones into the step. */
function collectStore(sb, stepDir) {
  const runs = path.join(sb.store, 'runs');
  const dest = path.join(stepDir, 'store');
  fs.mkdirSync(dest, { recursive: true });
  const listing = [];
  const walk = d => {
    if (!fs.existsSync(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      const rel = path.relative(sb.store, p);
      if (ent.isDirectory()) walk(p);
      else {
        const size = fs.statSync(p).size;
        listing.push(`${rel} (${size} B)`);
        if (size <= 1024 * 1024) {
          fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
          fs.copyFileSync(p, path.join(dest, rel));
        }
      }
    }
  };
  walk(runs);
  fs.writeFileSync(path.join(dest, 'listing.txt'), listing.join('\n') + '\n');
}

function worktreeLeaks(sb) {
  const out = [];
  const walk = (d, depth) => {
    if (!fs.existsSync(d) || depth > 3) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const p = path.join(d, ent.name);
      if (fs.existsSync(path.join(p, '.git')))
        out.push(path.relative(sb.worktrees, p));
      else walk(p, depth + 1);
    }
  };
  walk(sb.worktrees, 0);
  return out;
}

/** `e`'s scratch dirs (rendered secret files) currently in the temp dir. */
function scratchDirs() {
  try {
    return fs
      .readdirSync(os.tmpdir())
      .filter(n => n.startsWith('e-scratch-'))
      .map(n => path.join(os.tmpdir(), n));
  } catch {
    return [];
  }
}

function stillExists(kind, id) {
  return sh(ENGINE, [kind, 'inspect', id]).status === 0;
}

async function cmdRun(positionals, values, eArgs) {
  const root = path.resolve(values.root ?? DEFAULT_ROOT);
  const sb = readSandbox(root, positionals[0]);
  if (eArgs.length === 0) die('nothing to run: pass the e command after `--`');

  const steps = fs
    .readdirSync(path.join(sb.dir, 'steps'))
    .filter(s => /^\d+/.test(s));
  const step = steps.length + 1;
  const stepDir = path.join(
    sb.dir,
    'steps',
    `${String(step).padStart(2, '0')}-${stepSlug(eArgs)}`
  );
  fs.mkdirSync(stepDir, { recursive: true });
  const build = values['no-build']
    ? 'skipped'
    : ensureBuild(path.join(stepDir, 'build.log'), values.build);

  let scriptFile = values.script && path.resolve(values.script);
  if (values.turns) {
    scriptFile = path.join(stepDir, 'script.json');
    const turns = JSON.parse(values.turns);
    writeJson(scriptFile, Array.isArray(turns) ? { turns } : turns);
  } else if (scriptFile) {
    fs.copyFileSync(scriptFile, path.join(stepDir, 'script.json'));
  }

  let keys;
  if (values.tui || values['tui-keys']) {
    const raw = values.tui
      ? JSON.parse(fs.readFileSync(path.resolve(values.tui), 'utf8'))
      : JSON.parse(values['tui-keys']);
    keys = parseKeys(raw);
    writeJson(path.join(stepDir, 'keys.json'), keys);
  }

  const cwd = values.cwd ? path.resolve(sb.repo, values.cwd) : sb.repo;
  const base = git(sb.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const before = branchShas(sb.repo);
  // Worktrees an earlier step left behind are that step's leak, not this one's.
  const worktreesBefore = new Set(worktreeLeaks(sb));
  // Scratch dirs hold rendered secrets: one that outlives its run is a leak.
  const scratchBefore = new Set(scratchDirs());
  const stub = await startStub(sb, stepDir, scriptFile);
  const events = startEventWatch(stepDir);
  const spool = startSpoolMirror(sb, stepDir);
  // `docker events` only reports what happens after it subscribed.
  await new Promise(r => setTimeout(r, 300));

  const env = {
    ...process.env,
    NO_COLOR: '1',
    E_WORKTREES_DIR: sb.worktrees,
    E_RUNTIME: ENGINE,
    ...(values.quiet ? {} : { VERBOSE: 'true' }),
  };
  for (const kv of values.env ?? []) {
    const eq = kv.indexOf('=');
    env[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  const argv = [CLI, ...eArgs];
  const started = Date.now();
  const stamp = () => `[${((Date.now() - started) / 1000).toFixed(3)}s]`;
  const combF = fs.createWriteStream(path.join(stepDir, 'combined.log'));
  let combined = '';
  const emit = line => {
    combF.write(line);
    combined += line;
    if (values.tee) process.stdout.write(line);
  };
  /** Splits a stream's text into timestamped, tagged combined.log lines. */
  const liner = tag => {
    let pending = '';
    return {
      push(text) {
        pending += text.replace(/\r\n/g, '\n');
        let nl;
        while ((nl = pending.indexOf('\n')) >= 0) {
          emit(`${stamp()} [${tag}] ${pending.slice(0, nl)}\n`);
          pending = pending.slice(nl + 1);
        }
      },
      end() {
        if (pending) emit(`${stamp()} [${tag}] ${pending}\n`);
        pending = '';
      },
    };
  };

  let timedOut = false;
  const timeoutMs = Number(values.timeout ?? 1200) * 1000;
  let exit;
  let tui;
  if (keys) {
    // Interactive: under a pty, driven by the keys script (tui.mjs).
    const tty = liner('tty');
    const timer = setTimeout(() => (timedOut = true), timeoutMs);
    const [cols, rows] = (values.size ?? '120x40').split('x').map(Number);
    tui = await runTui({
      argv: [process.execPath, ...argv],
      cwd,
      env,
      cols,
      rows,
      steps: keys,
      stepDir,
      onText: t => tty.push(t),
      settleMs: Number(values['tui-settle'] ?? 30) * 1000,
      paceMs: Number(values['tui-pace'] ?? 250),
    });
    tty.end();
    clearTimeout(timer);
    exit = { ...tui.exit, timedOut };
  } else {
    const child = spawn(process.execPath, argv, {
      cwd,
      env,
      stdio: [values.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (values.stdin) {
      child.stdin.end(fs.readFileSync(path.resolve(values.stdin)));
    }
    const outF = fs.createWriteStream(path.join(stepDir, 'stdout.log'));
    const errF = fs.createWriteStream(path.join(stepDir, 'stderr.log'));
    const tap = (stream, file, tag) => {
      const l = liner(tag);
      stream.on('data', chunk => {
        file.write(chunk);
        l.push(chunk.toString('utf8'));
      });
      stream.on('end', () => l.end());
    };
    tap(child.stdout, outF, 'out');
    tap(child.stderr, errF, 'err');
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGINT');
      setTimeout(
        () => child.exitCode === null && child.kill('SIGKILL'),
        15000
      ).unref();
    }, timeoutMs);
    const onSig = () => child.kill('SIGINT');
    process.on('SIGINT', onSig);
    exit = await new Promise(resolve =>
      child.on('close', (code, signal) =>
        resolve({ code, signal, timedOut: false })
      )
    );
    exit.timedOut = timedOut;
    clearTimeout(timer);
    process.off('SIGINT', onSig);
    await Promise.all([outF, errF].map(f => new Promise(r => f.end(r))));
  }
  const durationMs = Date.now() - started;
  spool.stop();
  await new Promise(r => combF.end(r));

  // Let --rm removals and network teardown land in the event stream.
  await new Promise(r => setTimeout(r, Number(values.settle ?? 3) * 1000));
  await events.stop();
  stub.kill('SIGTERM');

  const evLines = fs
    .readFileSync(path.join(stepDir, 'docker-events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const folded = foldEvents(evLines);
  // A worktree `e` said it kept (it holds uncommitted work) is on purpose.
  const newWorktrees = worktreeLeaks(sb).filter(w => !worktreesBefore.has(w));
  const announced = w =>
    combined.includes(`Worktree kept at ${path.join(sb.worktrees, w)}:`);
  const leaks = {
    ...findLeaks(folded, stillExists),
    worktrees: newWorktrees.filter(w => !announced(w)),
    kept: newWorktrees.filter(announced),
    scratch: scratchDirs().filter(d => !scratchBefore.has(d)),
  };
  const gitFacts = collectGit(sb, stepDir, before, base);
  collectStore(sb, stepDir);
  const modelFile = path.join(stepDir, 'model.jsonl');
  const modelEntries = fs.existsSync(modelFile)
    ? fs
        .readFileSync(modelFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : [];

  const facts = {
    step,
    argv: eArgs,
    cwd,
    build,
    exit,
    durationMs,
    model: sb.upstream
      ? `live proxy -> ${sb.upstream}`
      : `stub${scriptFile ? ` (${path.basename(scriptFile)})` : ' (no script: answers "done")'}`,
    tui: tui && {
      steps: tui.steps,
      failed: tui.failed,
      final: tui.final,
    },
    lines: interestingLines(combined),
    tail: tailLines(combined),
    folded,
    modelSummary: summarizeModelLog(modelEntries),
    git: gitFacts,
    leaks,
  };
  writeJson(path.join(stepDir, 'cmd.json'), {
    argv: ['node', ...argv],
    cwd,
    env: {
      E_WORKTREES_DIR: sb.worktrees,
      E_RUNTIME: ENGINE,
      VERBOSE: env.VERBOSE,
    },
    started: new Date(started).toISOString(),
    durationMs,
    exit,
    build,
  });
  fs.writeFileSync(
    path.join(stepDir, 'commands.txt'),
    facts.lines.commands.join('\n') + '\n'
  );
  let summary = renderSummary(facts);
  if (gitFacts.checkoutDirty)
    summary += `\n## WARNING: the user checkout changed\n\n\`\`\`\n${gitFacts.checkoutDirty}\n\`\`\`\n`;
  fs.writeFileSync(path.join(stepDir, 'summary.md'), summary);
  process.stdout.write(summary + `\ntrace: ${stepDir}\n`);
  process.exitCode = exit.code ?? 1;
}

// ---------------------------------------------------------------- report/list/clean

function cmdReport(positionals, values) {
  const root = path.resolve(values.root ?? DEFAULT_ROOT);
  const sb = readSandbox(root, positionals[0]);
  const stepsDir = path.join(sb.dir, 'steps');
  const steps = fs.readdirSync(stepsDir).sort();
  process.stdout.write(`sandbox ${sb.name} (${sb.model}) ${sb.dir}\n\n`);
  for (const s of steps) {
    const f = path.join(stepsDir, s, 'summary.md');
    process.stdout.write(
      fs.existsSync(f)
        ? fs.readFileSync(f, 'utf8') + '\n'
        : `# ${s}: (no summary, still running?)\n\n`
    );
  }
}

function cmdList(values) {
  const root = path.resolve(values.root ?? DEFAULT_ROOT);
  if (!fs.existsSync(root)) return process.stdout.write('(no sandboxes)\n');
  for (const name of fs.readdirSync(root).sort()) {
    const f = path.join(root, name, 'sandbox.json');
    if (!fs.existsSync(f)) continue;
    const sb = JSON.parse(fs.readFileSync(f, 'utf8'));
    const steps = fs.readdirSync(path.join(sb.dir, 'steps')).length;
    process.stdout.write(
      `${name}\t${sb.model}\t${steps} step(s)\t${sb.created}\n`
    );
  }
}

function cmdClean(positionals, values) {
  const root = path.resolve(values.root ?? DEFAULT_ROOT);
  const names = values.all
    ? fs.existsSync(root)
      ? fs.readdirSync(root)
      : []
    : [positionals[0] ?? die('clean <name> or --all')];
  for (const name of names) {
    const dir = sandboxDir(root, name);
    if (!fs.existsSync(path.join(dir, 'sandbox.json'))) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    process.stdout.write(`removed ${dir}\n`);
  }
  if (values.images) {
    const r = sh(ENGINE, [
      'images',
      '--format',
      '{{.Repository}}',
      '--filter',
      'reference=e-agent-e2e-*',
    ]);
    for (const img of r.stdout.split('\n').filter(Boolean)) {
      sh(ENGINE, ['rmi', img]);
      process.stdout.write(`removed image ${img}\n`);
    }
  }
}

// ---------------------------------------------------------------- main

const all = process.argv.slice(2);
const dd = all.indexOf('--');
const own = dd >= 0 ? all.slice(0, dd) : all;
const eArgs = dd >= 0 ? all.slice(dd + 1) : [];
const { values, positionals } = parseArgs({
  args: own,
  allowPositionals: true,
  options: {
    root: { type: 'string' },
    model: { type: 'string' },
    'live-model': { type: 'string' },
    force: { type: 'boolean' },
    script: { type: 'string' },
    turns: { type: 'string' },
    tee: { type: 'boolean' },
    quiet: { type: 'boolean' },
    timeout: { type: 'string' },
    settle: { type: 'string' },
    stdin: { type: 'string' },
    tui: { type: 'string' },
    'tui-keys': { type: 'string' },
    'tui-settle': { type: 'string' },
    'tui-pace': { type: 'string' },
    size: { type: 'string' },
    cwd: { type: 'string' },
    env: { type: 'string', multiple: true },
    build: { type: 'boolean' },
    'no-build': { type: 'boolean' },
    all: { type: 'boolean' },
    images: { type: 'boolean' },
  },
});
const [sub, ...rest] = positionals;
switch (sub) {
  case 'new':
    await cmdNew(rest, values);
    break;
  case 'run':
    await cmdRun(rest, values, eArgs);
    break;
  case 'report':
    cmdReport(rest, values);
    break;
  case 'list':
    cmdList(values);
    break;
  case 'clean':
    cmdClean(rest, values);
    break;
  default:
    process.stdout.write(
      fs
        .readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\n')
        .filter(l => l.startsWith('//'))
        .map(l => l.slice(3))
        .join('\n') + '\n'
    );
    process.exitCode = sub ? 2 : 0;
}
