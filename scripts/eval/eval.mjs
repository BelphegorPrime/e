#!/usr/bin/env node
// The evaluation harness for fusion (#179): runs benchmark tasks under
// single-Agent and Fusion arms with the real `e` CLI, scores every result
// branch with the task's hidden check, and writes one machine-readable
// record per trial plus an aggregate. Single-agent execution is the
// baseline; nothing here assumes fusion is better. See bench/README.md.
//
//   node scripts/eval/eval.mjs run <suite.json> [--model stub|live] [--out dir]
//        [--trials N] [--arm name]... [--task name]... [--no-warmup] [--tee]
//   node scripts/eval/eval.mjs report <out dir>
//
// `--model stub` points every Agent at a scripted model that applies the
// task's own solution turns: it tests the harness and the pipeline, not a
// model. `--model live` runs the Agents as the suite's Store declares them.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  CLI,
  ENGINE,
  REPO,
  bridgeGateway,
  ensureBuild,
  freePort,
  initSandboxStore,
  seedRepo,
  sh,
} from '../e2e/host.mjs';
import { startStub } from '../e2e/stub-model.mjs';
import {
  STUB_KEY_ENV,
  aggregate,
  applyOverrides,
  branchesToCheck,
  checkVerdict,
  digestFiles,
  evalName,
  fusionTrialRecord,
  newEntries,
  parseSuite,
  parseTask,
  pickEnv,
  renderSummary,
  singleTrialRecord,
  storeCopyPlan,
  stripEnv,
  stubProvider,
  stubScript,
  usageFromModelLog,
} from './lib.mjs';

const DEFAULT_ROOT = path.join(REPO, '.eval');
/** Where a task's hidden check files land in the checkout the check runs in. */
const CHECK_DIR = '.eval-check';
/** How many times the stub serves a task's solution in one trial: candidates, synthesizer and verify retries. */
const STUB_COPIES = 16;
/** Past a trial's timeout: SIGTERM, then this long for `e` to tear down before SIGKILL. */
const TEARDOWN_GRACE_MS = 150_000;
/** A warm-up only builds images; past this something is wrong. */
const WARMUP_TIMEOUT_MS = 60 * 60 * 1000;

const die = msg => {
  process.stderr.write(`eval: ${msg}\n`);
  process.exit(2);
};

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const readJsonOr = (file, fallback) => {
  try {
    return readJson(file);
  } catch {
    return fallback;
  }
};
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
const listDir = dir => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return {};
      }
    });
}

/** Every file under `dir`, relative to `root`, for the task digest. */
function filesUnder(root, dir) {
  const out = [];
  const walk = d => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else
        out.push({ path: path.relative(root, p), content: fs.readFileSync(p) });
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** The `e` under test: its version and the commit it was built from, for the records. */
function eProvenance() {
  const version = readJson(path.join(REPO, 'package.json')).version;
  const commit = sh('git', ['rev-parse', 'HEAD'], { cwd: REPO }).stdout.trim();
  const dirty =
    sh('git', ['status', '--porcelain', '--', 'src'], {
      cwd: REPO,
    }).stdout.trim() !== '';
  return { version, commit, ...(dirty ? { dirty: true } : {}) };
}

/**
 * What a signal must undo: a check container still running, and the live
 * keys copied into the sandbox. `e` itself shares the terminal's process
 * group and gets the signal on its own.
 */
const cleanup = { container: undefined, envKeys: undefined };
function undoOnExit() {
  if (cleanup.container) sh(ENGINE, ['rm', '-f', cleanup.container]);
  if (cleanup.envKeys) {
    const { file, names } = cleanup.envKeys;
    if (fs.existsSync(file))
      fs.writeFileSync(file, stripEnv(fs.readFileSync(file, 'utf8'), names));
    cleanup.envKeys = undefined;
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    undoOnExit();
    process.exit(130);
  });
}

// ---------------------------------------------------------------- the sandbox

/**
 * The sandbox Store every trial of a run uses (`initSandboxStore`), holding
 * only the Agents and profiles the arms reach, `eval-` prefixed so no image
 * of the user's own is rebuilt, and the skills those Agents bake. In a live
 * run the keys they name (`apiKeyEnv`) are copied from the suite Store's
 * `.env`, and nothing else; they leave again when the run ends.
 */
function buildSandbox(out, suite, storeDir, model, stub) {
  const dir = path.join(out, 'sandbox');
  fs.mkdirSync(dir, { recursive: true });
  let store, config;
  try {
    ({ store, config } = initSandboxStore(dir));
  } catch (err) {
    die(err.message);
  }

  const sourceProfiles = {};
  for (const arm of suite.arms) {
    if (arm.kind !== 'fusion') continue;
    const file = path.join(storeDir, 'fusions', arm.profile, 'fusion.json');
    if (fs.existsSync(file)) sourceProfiles[arm.profile] = readJson(file);
  }
  let plan;
  try {
    plan = storeCopyPlan(suite, sourceProfiles);
  } catch (err) {
    die(err.message);
  }
  const agents = [];
  const keyNames = new Set();
  for (const { from, to } of plan.agents) {
    const src = path.join(storeDir, 'agents', from);
    if (!fs.existsSync(path.join(src, 'agent.json'))) {
      die(`agent "${from}" is not in ${storeDir}/agents`);
    }
    const dst = path.join(store, 'agents', to);
    fs.cpSync(src, dst, { recursive: true });
    const agent = { ...readJson(path.join(dst, 'agent.json')), name: to };
    if (model === 'stub')
      agent.provider = stubProvider(agent.harness, stub.url);
    else if (agent.provider?.apiKeyEnv) keyNames.add(agent.provider.apiKeyEnv);
    writeJson(path.join(dst, 'agent.json'), agent);
    for (const skill of agent.skills ?? []) {
      const skillDir = path.join(storeDir, 'skills', skill);
      if (fs.existsSync(skillDir)) {
        fs.cpSync(skillDir, path.join(store, 'skills', skill), {
          recursive: true,
        });
      }
    }
    agents.push({ name: to, harness: agent.harness });
  }
  const profiles = {};
  for (const { from, to, profile } of plan.fusions) {
    writeJson(path.join(store, 'fusions', to, 'fusion.json'), profile);
    profiles[from] = profile;
  }

  const envFile = path.join(store, '.env');
  fs.appendFileSync(envFile, `\n${STUB_KEY_ENV}=eval-stub-key\n`);
  const names = [...keyNames];
  if (names.length > 0) {
    const source = path.join(storeDir, '.env');
    const picked = fs.existsSync(source)
      ? pickEnv(fs.readFileSync(source, 'utf8'), names)
      : '';
    fs.appendFileSync(envFile, picked);
    fs.chmodSync(envFile, 0o600);
    cleanup.envKeys = { file: envFile, names };
  }
  return { dir, store, config, agents, profiles };
}

/** The sandbox's `config.json` for one task: its in-run gate, or none. */
function setVerify(sb, task) {
  const config = { ...sb.config };
  if (task?.verify !== undefined) config.verify = task.verify;
  else delete config.verify;
  writeJson(path.join(sb.store, 'config.json'), config);
}

/** A fresh repository from a task's `repo/`, with a local bare origin, and the run's worktrees dir. */
function makeRepo(trialDir, fixture) {
  const repo = path.join(trialDir, 'repo');
  seedRepo(repo, path.join(trialDir, 'origin.git'), {
    user: 'eval',
    files:
      fixture && fs.existsSync(fixture) ? fixture : { 'README.md': '# eval\n' },
  });
  fs.mkdirSync(path.join(trialDir, 'worktrees'), { recursive: true });
  return repo;
}

// ---------------------------------------------------------------- running e

/** The `e` invocation of an arm: `e spawn <agent>` or `e fuse <profile>`, against the sandbox. */
function eArgs(arm, sb, prompt) {
  return arm.kind === 'single'
    ? ['spawn', evalName(arm.agent), '--dir', sb.dir, '--', prompt]
    : ['fuse', evalName(arm.profile), '--dir', sb.dir, '--', prompt];
}

/** Runs one `e` invocation to its end, or to `timeoutMs`: SIGTERM, then SIGKILL past the grace. */
function runE(args, { cwd, env, logFile, timeoutMs, tee }) {
  return new Promise(resolve => {
    const started = Date.now();
    const log = fs.createWriteStream(logFile);
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pipe = chunk => {
      log.write(chunk);
      if (tee) process.stdout.write(chunk);
    };
    child.stdout.on('data', pipe);
    child.stderr.on('data', pipe);
    let timedOut = false;
    let kill;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      kill = setTimeout(() => child.kill('SIGKILL'), TEARDOWN_GRACE_MS);
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(kill);
      log.end();
      resolve({
        exitCode: code ?? (signal ? 1 : 0),
        timedOut,
        latencyMs: Date.now() - started,
      });
    });
  });
}

/** The stub at `stub.host:stub.port`, serving `script` and logging to `logFile`, until the returned stop. */
async function serveStub(stub, script, logFile) {
  const server = await startStub({
    script,
    logFile,
    port: stub.port,
    host: stub.host,
  });
  return () =>
    new Promise(resolve => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
}

/**
 * Every image the arms need, built once before the first trial against the
 * stub with no turns, so no trial's latency includes a build and the
 * warm-up costs no model call. A live Agent's provider is put back after.
 */
async function warmUp(out, sb, stub) {
  setVerify(sb, undefined);
  const results = [];
  for (const agent of sb.agents) {
    const dir = path.join(out, 'warmup', agent.name);
    const repo = makeRepo(dir);
    const file = path.join(sb.store, 'agents', agent.name, 'agent.json');
    const declared = readJson(file);
    writeJson(file, {
      ...declared,
      provider: stubProvider(agent.harness, stub.url),
    });
    const stop = await serveStub(
      stub,
      { turns: [], final: 'done' },
      path.join(dir, 'model.jsonl')
    );
    process.stderr.write(`eval: warming up ${agent.name} (image build)...\n`);
    try {
      const r = await runE(
        eArgs(
          { kind: 'single', agent: agent.name },
          sb,
          'Warm-up: reply done.'
        ),
        {
          cwd: repo,
          env: { E_WORKTREES_DIR: path.join(dir, 'worktrees') },
          logFile: path.join(dir, 'e.log'),
          timeoutMs: WARMUP_TIMEOUT_MS,
        }
      );
      results.push({ agent: agent.name, ...r });
    } finally {
      await stop();
      writeJson(file, declared);
    }
  }
  return results;
}

// ---------------------------------------------------------------- the hidden check

/**
 * Runs the task's hidden check against `branch`: a detached checkout of it
 * with the task's `check/` copied in, in a container of `check.image`, no
 * network unless the task asks for one. The agent never saw these files.
 */
async function runCheck({ repo, branch, taskDir, task, trialDir }) {
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, '_');
  const wt = path.join(trialDir, 'checks', slug);
  fs.rmSync(wt, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const added = sh('git', ['worktree', 'add', '-q', '--detach', wt, branch], {
    cwd: repo,
  });
  if (added.status !== 0) {
    return {
      verdict: 'broken',
      exitCode: null,
      durationMs: 0,
      timedOut: false,
      error: added.stderr.trim(),
    };
  }
  const hidden = path.join(taskDir, 'check');
  if (fs.existsSync(hidden))
    fs.cpSync(hidden, path.join(wt, CHECK_DIR), { recursive: true });
  const name = `eval-check-${crypto.randomBytes(4).toString('hex')}`;
  const user =
    typeof process.getuid === 'function'
      ? ['--user', `${process.getuid()}:${process.getgid()}`]
      : [];
  const args = [
    'run',
    '--rm',
    '--name',
    name,
    ...(task.check.network ? [] : ['--network', 'none']),
    ...user,
    '-v',
    `${wt}:/workspace`,
    '-w',
    '/workspace',
    '-e',
    'HOME=/tmp',
    task.check.image,
    'sh',
    '-c',
    task.check.command,
  ];
  const started = Date.now();
  cleanup.container = name;
  const result = await new Promise(resolve => {
    const child = spawn(ENGINE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', c => (output += c));
    child.stderr.on('data', c => (output += c));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      sh(ENGINE, ['rm', '-f', name]);
    }, task.check.timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, timedOut, output });
    });
  });
  cleanup.container = undefined;
  fs.writeFileSync(path.join(trialDir, 'checks', `${slug}.log`), result.output);
  sh('git', ['worktree', 'remove', '--force', wt], { cwd: repo });
  return {
    verdict: checkVerdict(result.exitCode, result.timedOut),
    exitCode: result.exitCode,
    durationMs: Date.now() - started,
    timedOut: result.timedOut,
  };
}

/** Whether `branch` exists in `repo`: a run that died early has none to check. */
const hasBranch = (repo, branch) =>
  sh('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: repo,
  }).status === 0;

// ---------------------------------------------------------------- one trial

/** The ledger entry a single run left in the sandbox Store, found by what is new since it started, and its session. */
function collectSingle(sb, before) {
  const live = path.join(sb.store, 'runs', 'live');
  const ids = newEntries(before.ledger, listDir(live)).filter(n =>
    n.startsWith('man-')
  );
  const ledger =
    ids.length > 0
      ? readJsonOr(path.join(live, ids.at(-1)), undefined)
      : undefined;
  let session;
  const sessions = path.join(sb.store, 'runs', 'sessions');
  for (const name of listDir(sessions)) {
    const s = readJsonOr(path.join(sessions, name, 'session.json'), undefined);
    if (s && ledger?.run && s.branch === ledger.run) session = s;
  }
  return { ledger, session };
}

/** The fusion record a fusion trial left, found the same way. */
function collectFusion(sb, before) {
  const root = path.join(sb.store, 'runs', 'fusions');
  const ids = newEntries(before.fusions, listDir(root)).filter(n =>
    n.startsWith('fusion-')
  );
  if (ids.length === 0) return {};
  const dir = path.join(root, ids.at(-1));
  const candidatesDir = path.join(dir, 'candidates');
  return {
    fusion: readJsonOr(path.join(dir, 'fusion.json'), undefined),
    candidates: listDir(candidatesDir)
      .map(id =>
        readJsonOr(path.join(candidatesDir, id, 'result.json'), undefined)
      )
      .filter(Boolean),
    synthesis: readJsonOr(path.join(dir, 'synthesis.json'), undefined),
  };
}

async function runTrial(ctx, { task, taskDir, arm, trial }) {
  const { out, sb, suite, model, stub, tee } = ctx;
  const trialDir = path.join(out, 'trials', task.name, arm.name, String(trial));
  fs.rmSync(trialDir, { recursive: true, force: true });
  const repo = makeRepo(trialDir, path.join(taskDir, 'repo'));
  setVerify(sb, task);
  const modelLog = path.join(trialDir, 'model.jsonl');
  const stop =
    model === 'stub'
      ? await serveStub(stub, stubScript(task, STUB_COPIES), modelLog)
      : undefined;
  const before = {
    ledger: listDir(path.join(sb.store, 'runs', 'live')),
    fusions: listDir(path.join(sb.store, 'runs', 'fusions')),
  };
  process.stderr.write(
    `eval: ${task.name} / ${arm.name} / trial ${trial}...\n`
  );
  const startedAt = new Date().toISOString();
  let run;
  try {
    run = await runE(eArgs(arm, sb, task.prompt), {
      cwd: repo,
      env: { E_WORKTREES_DIR: path.join(trialDir, 'worktrees') },
      logFile: path.join(trialDir, 'e.log'),
      timeoutMs: suite.timeoutMs,
      tee,
    });
  } finally {
    await stop?.();
  }
  const facts = {
    suite: suite.name,
    task: task.name,
    arm,
    trial,
    config: {
      ...ctx.config,
      taskDigest: ctx.digests[task.name],
      verify: task.verify ?? null,
      timeoutMs: suite.timeoutMs,
    },
    run: { startedAt, ...run },
    usage: model === 'stub' ? usageFromModelLog(readLines(modelLog)) : null,
  };
  const check = branch =>
    branch && hasBranch(repo, branch)
      ? runCheck({ repo, branch, taskDir, task, trialDir })
      : undefined;
  let record;
  if (arm.kind === 'single') {
    const { ledger, session } = collectSingle(sb, before);
    record = singleTrialRecord({
      ...facts,
      ledger,
      session,
      check: await check(ledger?.run),
    });
  } else {
    const found = collectFusion(sb, before);
    const checks = {};
    for (const branch of branchesToCheck(found)) {
      const result = await check(branch);
      if (result) checks[branch] = result;
    }
    record = fusionTrialRecord({
      ...facts,
      ...found,
      profile: sb.profiles[arm.profile],
      checks,
    });
  }
  writeJson(path.join(trialDir, 'trial.json'), record);
  return record;
}

// ---------------------------------------------------------------- commands

function summarizeInto(out, meta) {
  const results = readLines(path.join(out, 'results.jsonl')).filter(
    r => r.schemaVersion
  );
  const agg = aggregate(results);
  writeJson(path.join(out, 'summary.json'), { ...meta, ...agg });
  const md = renderSummary(agg, meta);
  fs.writeFileSync(path.join(out, 'summary.md'), md);
  return md;
}

async function cmdRun(positionals, values) {
  const suiteFile = positionals[0] && path.resolve(positionals[0]);
  if (!suiteFile || !fs.existsSync(suiteFile))
    die('run needs a suite file, e.g. bench/suites/smoke.json');
  const model = values.model ?? 'stub';
  if (!['stub', 'live'].includes(model)) die('--model is stub or live');
  const suiteDir = path.dirname(suiteFile);
  let suite;
  try {
    suite = applyOverrides(
      parseSuite(path.basename(suiteFile, '.json'), readJson(suiteFile)),
      values
    );
  } catch (err) {
    die(err.message);
  }
  const tasksDir = path.join(suiteDir, '..', 'tasks');
  const tasks = suite.tasks.map(name => {
    const taskDir = path.join(tasksDir, name);
    const file = path.join(taskDir, 'task.json');
    if (!fs.existsSync(file)) die(`no task ${name} at ${taskDir}`);
    try {
      return { task: parseTask(name, readJson(file)), taskDir };
    } catch (err) {
      return die(err.message);
    }
  });
  if (model === 'stub') {
    for (const { task } of tasks) {
      if (!task.stub)
        die(`task ${task.name} has no stub turns; run it with --model live`);
    }
  }
  const digests = Object.fromEntries(
    tasks.map(({ task, taskDir }) => [
      task.name,
      digestFiles(filesUnder(taskDir, taskDir)),
    ])
  );

  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..*/, '');
  const out = path.resolve(
    values.out ?? path.join(DEFAULT_ROOT, `${suite.name}-${stamp}`)
  );
  if (fs.existsSync(out) && listDir(out).length > 0) die(`${out} is not empty`);
  fs.mkdirSync(out, { recursive: true });
  try {
    ensureBuild(path.join(out, 'build.log'), false);
  } catch (err) {
    die(err.message);
  }

  const storeDir = path.resolve(suiteDir, suite.store);
  const host = bridgeGateway();
  const port = await freePort(host);
  const stub = { host, port, url: `http://${host}:${port}` };
  const sb = buildSandbox(out, suite, storeDir, model, stub);
  try {
    const config = { model, e: eProvenance() };
    const meta = {
      suite: suite.name,
      model,
      startedAt: new Date().toISOString(),
      e: config.e,
    };
    const warmup = values['no-warmup'] ? [] : await warmUp(out, sb, stub);
    writeJson(path.join(out, 'run.json'), {
      ...meta,
      suiteFile,
      storeDir,
      timeoutMs: suite.timeoutMs,
      arms: suite.arms,
      profiles: sb.profiles,
      tasks: suite.tasks,
      digests,
      trials: suite.trials,
      warmup,
    });

    const ctx = {
      out,
      sb,
      suite,
      model,
      stub,
      config,
      digests,
      tee: values.tee,
    };
    const results = path.join(out, 'results.jsonl');
    for (const { task, taskDir } of tasks) {
      for (const arm of suite.arms) {
        for (let trial = 1; trial <= suite.trials; trial++) {
          const record = await runTrial(ctx, { task, taskDir, arm, trial });
          fs.appendFileSync(results, JSON.stringify(record) + '\n');
          process.stderr.write(
            `eval: ${task.name} / ${arm.name} / ${trial}: check ${record.final.check.verdict}, exit ${record.exitCode}, ${(record.latencyMs / 1000).toFixed(1)} s\n`
          );
        }
      }
    }
    process.stdout.write(summarizeInto(out, meta));
    process.stdout.write(
      `\nresults: ${results}\nsummary: ${path.join(out, 'summary.json')}\n`
    );
  } finally {
    undoOnExit();
  }
}

function cmdReport(positionals) {
  const out = positionals[0] && path.resolve(positionals[0]);
  if (!out || !fs.existsSync(path.join(out, 'results.jsonl'))) {
    die('report needs a run directory with results.jsonl');
  }
  const run = readJsonOr(path.join(out, 'run.json'), {});
  process.stdout.write(
    summarizeInto(out, {
      suite: run.suite ?? path.basename(out),
      model: run.model ?? 'unknown',
      startedAt: run.startedAt,
      e: run.e,
    })
  );
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string' },
    out: { type: 'string' },
    trials: { type: 'string' },
    arm: { type: 'string', multiple: true },
    task: { type: 'string', multiple: true },
    'no-warmup': { type: 'boolean' },
    tee: { type: 'boolean' },
  },
});
const [command, ...rest] = positionals;
switch (command) {
  case 'run':
    await cmdRun(rest, values);
    break;
  case 'report':
    cmdReport(rest);
    break;
  default:
    die(
      'usage: eval.mjs run <suite.json> [--model stub|live] | report <out dir>'
    );
}
