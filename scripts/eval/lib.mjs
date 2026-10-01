// The pure core of the evaluation harness (#179): manifests in, one record
// per trial and an aggregate out. Nothing here touches a container, git or
// the disk, so `eval.mjs` stays glue and this stays testable.
//
// A trial runs one benchmark task under one arm - a single Agent (`e spawn`)
// or a Fusion profile (`e fuse`) - and is scored by the task's hidden check,
// run by the harness against the result branch after the run: the agent
// never sees it, so weakening the repository's own tests cannot game it. The
// in-run verify verdict is a column of its own.

import crypto from 'node:crypto';

/** The record shape `results.jsonl` holds; bumped on an incompatible change. */
export const SCHEMA_VERSION = 1;

/** The prefix every Agent and profile copied into the sandbox Store gets. */
export const EVAL_PREFIX = 'eval-';

/** The env var the stub's key travels in, appended to the sandbox `.env`. */
export const STUB_KEY_ENV = 'EVAL_MODEL_KEY';

const DEFAULT_CHECK = {
  image: 'node:lts-alpine',
  timeoutMs: 10 * 60 * 1000,
  network: false,
};

/** A whole trial's wall clock when the suite sets none: past every default Run and fusion budget would be wrong, so generous. */
const DEFAULT_TRIAL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** How each harness talks to the stub: the wire format, and a model id it accepts. */
const STUB_WIRE = {
  pi: { protocol: 'openai-chat', v1: true },
  codex: { protocol: 'openai-responses', v1: true },
  opencode: { protocol: 'openai-chat', v1: true },
  claudeCode: {
    protocol: 'anthropic-messages',
    v1: false,
    model: 'claude-sonnet-4-5',
  },
};

const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const positiveInt = v => Number.isInteger(v) && v > 0;

function refuseUnknown(what, raw, keys) {
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) throw new Error(`${what}: unknown key "${key}"`);
  }
}

// ---------------------------------------------------------------- manifests

/**
 * A benchmark task, `bench/tasks/<name>/task.json`: the prompt, the hidden
 * check, and optionally the in-run gate (`verify`, as `config.json` takes it)
 * and the stub's solution turns for `--model stub`.
 */
export function parseTask(name, raw) {
  const what = `task ${name}`;
  if (!isObject(raw)) throw new Error(`${what}: expected an object`);
  refuseUnknown(what, raw, ['prompt', 'verify', 'check', 'stub']);
  if (typeof raw.prompt !== 'string' || raw.prompt.trim() === '') {
    throw new Error(`${what}: prompt must be a non-empty string`);
  }
  const check = raw.check;
  if (!isObject(check) || typeof check.command !== 'string' || !check.command) {
    throw new Error(`${what}: check.command is required`);
  }
  refuseUnknown(`${what} check`, check, [
    'command',
    'image',
    'timeoutMs',
    'network',
  ]);
  if (check.timeoutMs !== undefined && !positiveInt(check.timeoutMs)) {
    throw new Error(`${what}: check.timeoutMs must be a positive integer`);
  }
  if (raw.stub !== undefined && !Array.isArray(raw.stub?.turns)) {
    throw new Error(`${what}: stub.turns must be an array`);
  }
  return {
    name,
    prompt: raw.prompt,
    ...(raw.verify !== undefined ? { verify: raw.verify } : {}),
    check: {
      command: check.command,
      image: check.image ?? DEFAULT_CHECK.image,
      timeoutMs: check.timeoutMs ?? DEFAULT_CHECK.timeoutMs,
      network: check.network ?? DEFAULT_CHECK.network,
    },
    ...(raw.stub !== undefined ? { stub: { turns: raw.stub.turns } } : {}),
  };
}

/**
 * A suite, `bench/suites/<name>.json`: the Store whose Agents and profiles
 * the arms name (a `.e` directory, relative to the suite file), the tasks,
 * how many trials of each, and the arms.
 */
export function parseSuite(name, raw) {
  const what = `suite ${name}`;
  if (!isObject(raw)) throw new Error(`${what}: expected an object`);
  refuseUnknown(what, raw, ['store', 'tasks', 'trials', 'timeoutMs', 'arms']);
  if (typeof raw.store !== 'string' || raw.store === '') {
    throw new Error(`${what}: store must name a .e directory`);
  }
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new Error(`${what}: needs at least one task`);
  }
  const trials = raw.trials ?? 1;
  if (!positiveInt(trials))
    throw new Error(`${what}: trials must be a positive integer`);
  const timeoutMs = raw.timeoutMs ?? DEFAULT_TRIAL_TIMEOUT_MS;
  if (!positiveInt(timeoutMs))
    throw new Error(`${what}: timeoutMs must be a positive integer`);
  if (!Array.isArray(raw.arms) || raw.arms.length === 0) {
    throw new Error(`${what}: needs at least one arm`);
  }
  const seen = new Set();
  const arms = raw.arms.map(arm => {
    if (
      !isObject(arm) ||
      typeof arm.name !== 'string' ||
      !NAME.test(arm.name)
    ) {
      throw new Error(`${what}: every arm name must match ${NAME}`);
    }
    refuseUnknown(`${what} arm ${arm.name}`, arm, ['name', 'agent', 'profile']);
    if (seen.has(arm.name))
      throw new Error(`${what}: arm "${arm.name}" is named twice`);
    seen.add(arm.name);
    const hasAgent = typeof arm.agent === 'string' && arm.agent !== '';
    const hasProfile = typeof arm.profile === 'string' && arm.profile !== '';
    if (hasAgent === hasProfile) {
      throw new Error(
        `${what}: arm "${arm.name}" needs exactly one of agent or profile`
      );
    }
    return hasAgent
      ? { name: arm.name, kind: 'single', agent: arm.agent }
      : { name: arm.name, kind: 'fusion', profile: arm.profile };
  });
  return {
    name,
    store: raw.store,
    tasks: [...raw.tasks],
    trials,
    timeoutMs,
    arms,
  };
}

/**
 * A suite narrowed by the command line (`--trials`, `--arm`, `--task`),
 * checked like the suite itself: a typo is an error, never an empty run.
 */
export function applyOverrides(suite, { trials, arm, task }) {
  let out = suite;
  if (trials !== undefined) {
    const n = Number(trials);
    if (!positiveInt(n))
      throw new Error(`--trials must be a positive integer, not "${trials}"`);
    out = { ...out, trials: n };
  }
  if (arm?.length) {
    for (const name of arm) {
      if (!suite.arms.some(a => a.name === name))
        throw new Error(`the suite has no arm "${name}"`);
    }
    out = { ...out, arms: suite.arms.filter(a => arm.includes(a.name)) };
  }
  if (task?.length) {
    for (const name of task) {
      if (!suite.tasks.includes(name))
        throw new Error(`the suite has no task "${name}"`);
    }
    out = { ...out, tasks: suite.tasks.filter(t => task.includes(t)) };
  }
  return out;
}

/**
 * One digest over a task's files (`{path, content}`, any order): the task
 * identity a record carries, so a rerun after a task changed is told apart
 * from the original.
 */
export function digestFiles(files) {
  const hash = crypto.createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(`${f.path}\0${f.content.length}\0`);
    hash.update(f.content);
  }
  return `sha256:${hash.digest('hex')}`;
}

// ---------------------------------------------------------------- the sandbox store

/** The sandbox name of an Agent or profile: `eval-` prefixed, so no image tag of the user's own is rebuilt. */
export function evalName(name) {
  return name.startsWith(EVAL_PREFIX) ? name : `${EVAL_PREFIX}${name}`;
}

/**
 * What to copy from the suite's Store into the sandbox: every Agent an arm
 * names directly or through a profile, and every profile, renamed, with the
 * profile's Agent references renamed alike. `profiles` maps a profile name
 * to its parsed `fusion.json`.
 */
export function storeCopyPlan(suite, profiles) {
  const agents = [];
  const fusions = [];
  const addAgent = name => {
    if (!agents.some(a => a.from === name))
      agents.push({ from: name, to: evalName(name) });
  };
  for (const arm of suite.arms) {
    if (arm.kind === 'single') {
      addAgent(arm.agent);
      continue;
    }
    const profile = profiles[arm.profile];
    if (!profile)
      throw new Error(`profile "${arm.profile}" is not in the suite's store`);
    for (const name of [...profile.candidates, profile.synthesizer])
      addAgent(name);
    if (fusions.some(f => f.from === arm.profile)) continue;
    fusions.push({
      from: arm.profile,
      to: evalName(arm.profile),
      profile: {
        ...profile,
        ...(profile.name !== undefined ? { name: evalName(arm.profile) } : {}),
        candidates: profile.candidates.map(evalName),
        synthesizer: evalName(profile.synthesizer),
      },
    });
  }
  return { agents, fusions };
}

/** An Agent's provider block pointed at the stub at `at` (`http://host:port`). */
export function stubProvider(harness, at) {
  const wire = STUB_WIRE[harness];
  if (!wire) throw new Error(`harness "${harness}" has no stub wire format`);
  return {
    baseUrl: wire.v1 ? `${at}/v1` : at,
    model: wire.model ?? 'stub',
    protocol: wire.protocol,
    apiKeyEnv: STUB_KEY_ENV,
  };
}

/** The name a `.env` line assigns, or undefined for a comment or a blank. */
function envName(line) {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return m ? m[1] : undefined;
}

/**
 * The lines of a `.env` text that assign one of `names`, verbatim: in a live
 * run only the keys the copied Agents name (`apiKeyEnv`) reach the sandbox.
 */
export function pickEnv(text, names) {
  const lines = text.split('\n').filter(line => names.includes(envName(line)));
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

/** A `.env` text without the lines that assign one of `names`: the keys leave the sandbox with the run. */
export function stripEnv(text, names) {
  return text
    .split('\n')
    .filter(line => !names.includes(envName(line)))
    .join('\n');
}

/**
 * The stub's script for one trial: the task's solution turns, `copies`
 * times over, each served only to a request whose newest input is the task -
 * a conversation's opening request, a candidate's or the synthesizer's
 * (whose prompt carries the task verbatim). A follow-up after a tool result
 * gets `final`, so every conversation applies the solution once and ends.
 */
export function stubScript(task, copies) {
  const turns = [];
  for (let i = 0; i < copies; i++) {
    for (const turn of task.stub?.turns ?? [])
      turns.push({ ...turn, match: task.prompt });
  }
  return { turns, final: 'done' };
}

// ---------------------------------------------------------------- records

/** What a check's exit means: 125-127 is the image failing to run it (as verify reads it, ADR-0016). */
export function checkVerdict(exitCode, timedOut) {
  if (timedOut) return 'fail';
  if (exitCode === 0) return 'pass';
  if (exitCode >= 125 && exitCode <= 127) return 'broken';
  return 'fail';
}

/** The names a trial added to a directory listing, in name order. */
export function newEntries(before, after) {
  const had = new Set(before);
  return after.filter(name => !had.has(name)).sort();
}

const SKIPPED = { verdict: 'skipped' };

/** The in-run verify column of a single run, from its loop verdict. */
function loopVerify(ledger) {
  switch (ledger?.outcome) {
    case 'verified':
      return 'green';
    case 'exhausted':
      return 'red';
    case 'aborted':
      return ledger.reason === 'aborted:verify-broken' ? 'broken' : null;
    default:
      return null;
  }
}

function snapshotOf(agent) {
  return {
    name: agent.name,
    harness: agent.harness,
    harnessVersion: agent.harnessVersion,
    provider: agent.provider
      ? { protocol: agent.provider.protocol, model: agent.provider.model }
      : null,
  };
}

function base(facts, configExtra) {
  return {
    schemaVersion: SCHEMA_VERSION,
    suite: facts.suite,
    task: facts.task,
    arm: facts.arm.name,
    kind: facts.arm.kind,
    trial: facts.trial,
    config: { ...configExtra, ...facts.config },
    startedAt: facts.run.startedAt,
    latencyMs: facts.run.latencyMs,
    exitCode: facts.run.exitCode,
    timedOut: facts.run.timedOut,
  };
}

/**
 * One single-Agent trial: the run's ledger entry (`.e/runs/live/man-*.json`),
 * its session for provenance, and the hidden check of its branch. A run that
 * left no ledger entry is `no-record`; one without a branch is not checked.
 */
export function singleTrialRecord(facts) {
  const { ledger, session } = facts;
  return {
    ...base(facts, {
      agent: facts.arm.agent,
      strategy: 'single',
      candidateCount: 1,
      agents: session ? [snapshotOf({ ...session, name: session.agent })] : [],
    }),
    final: {
      branch: ledger?.run ?? null,
      outcome: ledger ? (ledger.outcome ?? ledger.state) : 'no-record',
      reason: ledger?.reason ?? null,
      verify: loopVerify(ledger),
      check: facts.check ?? SKIPPED,
    },
    candidates: [],
    select: null,
    usage: facts.usage ?? null,
    records: { ledger: ledger?.id ?? null, fusion: null },
  };
}

/**
 * The pick a select-only judge would make from the candidates it can see,
 * without a strategy of its own. It weighs each slot's last attempt (a
 * retried one is not the slot's answer), in slot order: with a gate, the
 * first that went green, or none; with no gate at all, the first with
 * commits.
 */
export function selectByVerify(candidates) {
  const finals = candidates.filter(c => c.final);
  const gated = finals.some(c => c.verify !== null);
  const pick = gated
    ? finals.find(c => c.verify === 'green')
    : finals.find(c => c.tip !== null);
  return pick
    ? { candidate: pick.candidate, check: pick.check.verdict }
    : { candidate: null, check: null };
}

/**
 * The candidates in the fusion record's order (the profile's slots, then
 * the retries), each with its slot - a retry inherits the one it replaces -
 * and whether it is the slot's last attempt.
 */
function inSlots(results, order) {
  const rank = id => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  const sorted = [...results].sort(
    (a, b) =>
      rank(a.candidate) - rank(b.candidate) ||
      (a.candidate < b.candidate ? -1 : 1)
  );
  const slotOf = new Map();
  let next = 0;
  for (const c of sorted) {
    slotOf.set(
      c.candidate,
      c.retryOf ? (slotOf.get(c.retryOf) ?? next++) : next++
    );
  }
  const retried = new Set(sorted.map(c => c.retryOf).filter(Boolean));
  return sorted.map(c => ({
    ...c,
    slot: slotOf.get(c.candidate),
    final: !retried.has(c.candidate),
  }));
}

/** The branches a fusion trial's hidden check runs against: every candidate with commits, and the synthesis. */
export function branchesToCheck({ candidates, synthesis }) {
  const branches = (candidates ?? [])
    .filter(c => c.tip !== null && c.branch)
    .map(c => c.branch);
  if (synthesis?.branch) branches.push(synthesis.branch);
  return [...new Set(branches)];
}

/**
 * One fusion trial: `fusion.json`, every candidate's `result.json`, the
 * synthesis's `synthesis.json`, and the hidden check of each branch scored
 * (`checks`, by branch). Beside the synthesis, two numbers from the same
 * candidates at no extra run: the pick of a select-only judge
 * ({@link selectByVerify}), and the oracle - whether any candidate passed.
 */
export function fusionTrialRecord(facts) {
  const { fusion, synthesis, profile } = facts;
  const checks = facts.checks ?? {};
  const candidates = inSlots(
    facts.candidates ?? [],
    fusion?.candidates ?? []
  ).map(c => ({
    candidate: c.candidate,
    slot: c.slot,
    final: c.final,
    agent: c.agent,
    outcome: c.outcome,
    branch: c.branch,
    tip: c.tip,
    verify: c.verify?.verdict ?? null,
    elapsedMs: c.elapsedMs,
    attempt: c.attempt,
    retryOf: c.retryOf,
    check: (c.branch && c.tip !== null && checks[c.branch]) || SKIPPED,
  }));
  return {
    ...base(facts, {
      profile: facts.arm.profile,
      strategy: profile.strategy ?? 'parallel-synthesize',
      // From the profile the arm ran, so a fusion that left no record still counts.
      candidateCount: profile.candidates.length,
      synthesizer: profile.synthesizer,
      profileSpec: profile,
      agents: (fusion?.agents ?? []).map(snapshotOf),
    }),
    final: {
      branch: synthesis?.branch ?? null,
      outcome: fusion?.state ?? 'no-record',
      reason: fusion?.reason ?? synthesis?.reason ?? null,
      verify: synthesis?.verify?.verdict ?? null,
      check: (synthesis?.branch && checks[synthesis.branch]) || SKIPPED,
    },
    candidates,
    select: {
      byVerify: selectByVerify(candidates),
      oracle: candidates.some(c => c.check.verdict === 'pass'),
    },
    usage: facts.usage ?? null,
    records: { ledger: null, fusion: fusion?.fusion ?? null },
  };
}

function sumUsage(list) {
  const total = { inputTokens: 0, outputTokens: 0, requests: 0 };
  for (const u of list) {
    total.inputTokens += u.inputTokens ?? 0;
    total.outputTokens += u.outputTokens ?? 0;
    total.requests += u.requests ?? 0;
    if (u.costUsd !== undefined)
      total.costUsd = (total.costUsd ?? 0) + u.costUsd;
  }
  return total;
}

/** Every `usage` object anywhere in a logged reply, in any of the three wire formats. */
function usagesIn(value, out) {
  if (Array.isArray(value)) {
    for (const v of value) usagesIn(v, out);
  } else if (isObject(value)) {
    if (isObject(value.usage)) out.push(value.usage);
    for (const [key, v] of Object.entries(value))
      if (key !== 'usage') usagesIn(v, out);
  }
  return out;
}

/**
 * The tokens a trial's model traffic carried, from the stub's or recording
 * proxy's `model.jsonl` lines; `null` when nothing was logged - unknown,
 * never estimated.
 */
export function usageFromModelLog(lines) {
  const replies = [];
  for (const line of lines) {
    if (line.dir !== 'res') continue;
    const usages = usagesIn(line.body ?? line.stream ?? line, []);
    if (usages.length === 0) continue;
    const reply = { inputTokens: 0, outputTokens: 0, requests: 1 };
    for (const u of usages) {
      reply.inputTokens += u.input_tokens ?? u.prompt_tokens ?? u.input ?? 0;
      reply.outputTokens +=
        u.output_tokens ?? u.completion_tokens ?? u.output ?? 0;
      // pi-style providers report a cost beside the tokens.
      const cost = u.cost?.total;
      if (typeof cost === 'number') reply.costUsd = (reply.costUsd ?? 0) + cost;
    }
    replies.push(reply);
  }
  return replies.length > 0 ? sumUsage(replies) : null;
}

// ---------------------------------------------------------------- aggregate

const rate = (hits, of) => (of === 0 ? null : hits / of);

/** The candidate outcomes that are a failure: `empty` is an answer, a stopped one is not. */
const FAILED = ['failed', 'timed-out', 'canceled'];

function latency(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const p50 =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    mean: Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
    p50,
    max: sorted[sorted.length - 1],
  };
}

/** The numbers of one group of trials: an arm, or an arm on one task. */
function summarize(trials) {
  const gated = trials.filter(t => t.final.verify !== null);
  const fusion = trials.filter(t => t.kind === 'fusion');
  // Per slot: its last attempt is its answer, whatever the retries before it.
  const slots = fusion.flatMap(t => t.candidates).filter(c => c.final);
  const failed = slots.filter(c => FAILED.includes(c.outcome));
  const withUsage = trials.filter(t => t.usage !== null);
  return {
    trials: trials.length,
    checkPassRate: rate(
      trials.filter(t => t.final.check.verdict === 'pass').length,
      trials.length
    ),
    verifyGreenRate: rate(
      gated.filter(t => t.final.verify === 'green').length,
      gated.length
    ),
    exitZeroRate: rate(
      trials.filter(t => t.exitCode === 0).length,
      trials.length
    ),
    latencyMs: latency(trials.map(t => t.latencyMs)),
    candidateCount:
      trials.reduce((s, t) => s + t.config.candidateCount, 0) / trials.length,
    candidateFailureRate: rate(failed.length, slots.length),
    selectByVerifyPassRate: rate(
      fusion.filter(t => t.select.byVerify.check === 'pass').length,
      fusion.length
    ),
    oraclePassRate: rate(
      fusion.filter(t => t.select.oracle).length,
      fusion.length
    ),
    usage:
      withUsage.length === 0
        ? 'unavailable'
        : {
            trialsWithUsage: withUsage.length,
            ...sumUsage(withUsage.map(t => t.usage)),
          },
  };
}

function groupBy(list, keyOf) {
  const groups = new Map();
  for (const item of list) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The comparison: per arm over every task, and per task and arm. */
export function aggregate(results) {
  return {
    schemaVersion: SCHEMA_VERSION,
    arms: groupBy(results, r => r.arm).map(([arm, trials]) => ({
      arm,
      kind: trials[0].kind,
      strategy: trials[0].config.strategy,
      ...summarize(trials),
    })),
    tasks: groupBy(results, r => `${r.task}\0${r.arm}`).map(([, trials]) => ({
      task: trials[0].task,
      arm: trials[0].arm,
      ...summarize(trials),
    })),
  };
}

const pct = v => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);
const secs = ms => `${(ms / 1000).toFixed(1)} s`;
const tokens = u =>
  u === 'unavailable'
    ? 'unavailable'
    : `${u.inputTokens} in / ${u.outputTokens} out${u.costUsd !== undefined ? `, $${u.costUsd.toFixed(4)}` : ''} (${u.trialsWithUsage} trials)`;

/** `summary.md`: the arms side by side, then each task. */
export function renderSummary(agg, meta) {
  const head =
    '| arm | strategy | trials | check pass | verify green | exit 0 | latency p50 | latency max | candidates | candidate failures | select@verify | oracle | usage |';
  const rule = `|${' --- |'.repeat(13)}`;
  const row = (name, strategy, s) =>
    `| ${name} | ${strategy} | ${s.trials} | ${pct(s.checkPassRate)} | ${pct(s.verifyGreenRate)} | ${pct(s.exitZeroRate)} | ${secs(s.latencyMs.p50)} | ${secs(s.latencyMs.max)} | ${s.candidateCount} | ${pct(s.candidateFailureRate)} | ${pct(s.selectByVerifyPassRate)} | ${pct(s.oraclePassRate)} | ${tokens(s.usage)} |`;
  const strategyOf = arm => agg.arms.find(a => a.arm === arm)?.strategy ?? '';
  return [
    `# Evaluation: ${meta.suite} (model ${meta.model})`,
    '',
    'Check pass is the hidden check against the result branch; verify green is the in-run gate over the trials that had one. select@verify is the candidate a select-only judge would have picked by its gate, oracle whether any candidate passed the check.',
    '',
    head,
    rule,
    ...agg.arms.map(a => row(a.arm, a.strategy, a)),
    '',
    '## Per task',
    '',
    head.replace('| arm |', '| task / arm |'),
    rule,
    ...agg.tasks.map(t => row(`${t.task} / ${t.arm}`, strategyOf(t.arm), t)),
    '',
  ].join('\n');
}
