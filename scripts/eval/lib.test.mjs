import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
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
  selectByVerify,
  singleTrialRecord,
  storeCopyPlan,
  stripEnv,
  stubProvider,
  stubScript,
  usageFromModelLog,
} from './lib.mjs';

/*
 * The evaluation harness's pure core (#179): manifests in, trial records and
 * an aggregate out, so the comparison logic is tested without a container.
 */

// ---------------------------------------------------------------- manifests

test('parseTask: a prompt and a hidden check are required; the rest is optional', () => {
  const task = parseTask('fix-sum', {
    prompt: 'Fix sum.js',
    check: { command: 'node --test .eval-check' },
  });
  assert.deepEqual(task, {
    name: 'fix-sum',
    prompt: 'Fix sum.js',
    check: {
      command: 'node --test .eval-check',
      image: 'node:lts-alpine',
      timeoutMs: 600_000,
      network: false,
    },
  });
  const full = parseTask('greet', {
    prompt: 'Add greet()',
    verify: 'node --test',
    check: {
      command: 'npm test',
      image: 'node:22',
      timeoutMs: 1000,
      network: true,
    },
    stub: { turns: [{ tool: 'bash', args: { command: 'true' } }] },
  });
  assert.equal(full.verify, 'node --test');
  assert.equal(full.check.image, 'node:22');
  assert.equal(full.check.network, true);
  assert.equal(full.stub.turns.length, 1);
});

test('parseTask: refuses what would make a trial meaningless', () => {
  assert.throws(() => parseTask('t', { check: { command: 'x' } }), /prompt/);
  assert.throws(() => parseTask('t', { prompt: 'p' }), /check\.command/);
  assert.throws(
    () =>
      parseTask('t', { prompt: 'p', check: { command: 'x', timeoutMs: 0 } }),
    /timeoutMs/
  );
  assert.throws(
    () => parseTask('t', { prompt: 'p', check: { command: 'x' }, extra: 1 }),
    /unknown key "extra"/
  );
});

test('parseSuite: arms are single agents or fusion profiles, named uniquely', () => {
  const suite = parseSuite('smoke', {
    store: '../store',
    tasks: ['fix-sum'],
    arms: [
      { name: 'single-pi', agent: 'pi' },
      { name: 'fusion-pair', profile: 'pi-pair' },
    ],
  });
  assert.equal(suite.trials, 1);
  assert.equal(suite.timeoutMs, 7_200_000);
  assert.deepEqual(
    suite.arms.map(a => [a.name, a.kind]),
    [
      ['single-pi', 'single'],
      ['fusion-pair', 'fusion'],
    ]
  );
  const bad = arms => () => parseSuite('s', { store: 's', tasks: ['t'], arms });
  assert.throws(bad([]), /at least one arm/);
  assert.throws(bad([{ name: 'a', agent: 'x', profile: 'y' }]), /exactly one/);
  assert.throws(bad([{ name: 'a' }]), /exactly one/);
  assert.throws(
    bad([
      { name: 'a', agent: 'x' },
      { name: 'a', agent: 'y' },
    ]),
    /twice/
  );
  assert.throws(bad([{ name: 'A b', agent: 'x' }]), /arm name/);
  assert.throws(
    () =>
      parseSuite('s', {
        store: 's',
        tasks: [],
        arms: [{ name: 'a', agent: 'x' }],
      }),
    /at least one task/
  );
  assert.throws(
    () =>
      parseSuite('s', {
        store: 's',
        tasks: ['t'],
        trials: 0,
        arms: [{ name: 'a', agent: 'x' }],
      }),
    /trials/
  );
});

test('applyOverrides: the command line narrows a suite, checked like the suite itself', () => {
  const suite = parseSuite('s', {
    store: 's',
    tasks: ['a', 'b'],
    arms: [
      { name: 'x', agent: 'pi' },
      { name: 'y', profile: 'p' },
    ],
  });
  const narrowed = applyOverrides(suite, {
    trials: '4',
    arm: ['y'],
    task: ['b'],
  });
  assert.equal(narrowed.trials, 4);
  assert.deepEqual(
    narrowed.arms.map(a => a.name),
    ['y']
  );
  assert.deepEqual(narrowed.tasks, ['b']);
  assert.equal(applyOverrides(suite, {}), suite);
  assert.throws(() => applyOverrides(suite, { trials: 'abc' }), /--trials/);
  assert.throws(() => applyOverrides(suite, { trials: '0' }), /--trials/);
  assert.throws(
    () => applyOverrides(suite, { arm: ['nope'] }),
    /no arm "nope"/
  );
  assert.throws(
    () => applyOverrides(suite, { task: ['nope'] }),
    /no task "nope"/
  );
});

test("digestFiles: one hash over a task's files, independent of listing order", () => {
  const a = digestFiles([
    { path: 'task.json', content: '{}' },
    { path: 'repo/x.js', content: 'x' },
  ]);
  const b = digestFiles([
    { path: 'repo/x.js', content: 'x' },
    { path: 'task.json', content: '{}' },
  ]);
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(
    a,
    digestFiles([
      { path: 'task.json', content: '{}' },
      { path: 'repo/x.js', content: 'y' },
    ])
  );
});

// ---------------------------------------------------------------- the sandbox store

test('evalName: every copied Agent and profile is eval-prefixed, once', () => {
  assert.equal(evalName('claude'), 'eval-claude');
  assert.equal(evalName('eval-claude'), 'eval-claude');
});

test('storeCopyPlan: only what the arms reach, renamed, with profiles pointing at the renamed Agents', () => {
  const suite = parseSuite('s', {
    store: 's',
    tasks: ['t'],
    arms: [
      { name: 'single', agent: 'claude' },
      { name: 'fusion', profile: 'mix' },
    ],
  });
  const plan = storeCopyPlan(suite, {
    mix: { candidates: ['claude', 'codex', 'codex'], synthesizer: 'reviewer' },
  });
  assert.deepEqual(plan.agents, [
    { from: 'claude', to: 'eval-claude' },
    { from: 'codex', to: 'eval-codex' },
    { from: 'reviewer', to: 'eval-reviewer' },
  ]);
  assert.deepEqual(plan.fusions, [
    {
      from: 'mix',
      to: 'eval-mix',
      profile: {
        candidates: ['eval-claude', 'eval-codex', 'eval-codex'],
        synthesizer: 'eval-reviewer',
      },
    },
  ]);
  assert.throws(
    () => storeCopyPlan(suite, {}),
    /profile "mix" is not in the suite's store/
  );
});

test('stubProvider: each harness talks its own wire format to the stub', () => {
  const at = 'http://172.17.0.1:4000';
  assert.deepEqual(stubProvider('pi', at), {
    baseUrl: `${at}/v1`,
    model: 'stub',
    protocol: 'openai-chat',
    apiKeyEnv: 'EVAL_MODEL_KEY',
  });
  assert.equal(stubProvider('codex', at).protocol, 'openai-responses');
  assert.deepEqual(stubProvider('claudeCode', at), {
    baseUrl: at,
    model: 'claude-sonnet-4-5',
    protocol: 'anthropic-messages',
    apiKeyEnv: 'EVAL_MODEL_KEY',
  });
  assert.throws(() => stubProvider('nope', at), /no stub wire format/);
});

test('pickEnv / stripEnv: only the keys the copied Agents name travel, and leave again', () => {
  const source = [
    '# provider keys',
    'ANTHROPIC_API_KEY=sk-ant',
    'OPENAI_API_KEY="sk-oai"',
    'UNRELATED=x',
    '',
  ].join('\n');
  const picked = pickEnv(source, [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'MISSING',
  ]);
  assert.equal(picked, 'ANTHROPIC_API_KEY=sk-ant\nOPENAI_API_KEY="sk-oai"\n');
  const sandbox = `STACK=1\n${picked}EVAL_MODEL_KEY=k\n`;
  assert.equal(
    stripEnv(sandbox, ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']),
    'STACK=1\nEVAL_MODEL_KEY=k\n'
  );
});

test('stubScript: the solution once per conversation, keyed on the prompt', () => {
  const task = parseTask('t', {
    prompt: 'Fix sum.js so that sum adds',
    check: { command: 'x' },
    stub: { turns: [{ tool: 'bash', args: { command: 'fix' } }] },
  });
  const script = stubScript(task, 3);
  assert.equal(script.turns.length, 3);
  // Only a conversation's opening request, whose newest input is the task,
  // gets the solution; a follow-up after the tool result gets `final`.
  for (const turn of script.turns) {
    assert.equal(turn.match, 'Fix sum.js so that sum adds');
    assert.deepEqual(turn.args, { command: 'fix' });
  }
  assert.equal(script.final, 'done');
  assert.deepEqual(
    stubScript(parseTask('t', { prompt: 'p', check: { command: 'x' } }), 3)
      .turns,
    []
  );
});

// ---------------------------------------------------------------- records

test('checkVerdict: pass, fail, broken (the image could not run it), timed out', () => {
  assert.equal(checkVerdict(0, false), 'pass');
  assert.equal(checkVerdict(1, false), 'fail');
  assert.equal(checkVerdict(125, false), 'broken');
  assert.equal(checkVerdict(127, false), 'broken');
  assert.equal(checkVerdict(0, true), 'fail');
});

test('newEntries: what a trial added, in name order', () => {
  assert.deepEqual(newEntries(['a', 'b'], ['b', 'c', 'a', 'd']), ['c', 'd']);
});

const config = {
  model: 'stub',
  e: { version: '1.0.0', commit: 'abc' },
  taskDigest: 'sha256:t',
  verify: null,
  timeoutMs: 7_200_000,
};

test('singleTrialRecord: the ledger entry, the session and the check make one record', () => {
  const record = singleTrialRecord({
    suite: 'smoke',
    task: 'fix-sum',
    arm: { name: 'single-pi', kind: 'single', agent: 'pi' },
    trial: 1,
    config,
    run: {
      startedAt: '2026-10-01T10:00:00.000Z',
      latencyMs: 4200,
      exitCode: 0,
      timedOut: false,
    },
    ledger: {
      id: 'man-01',
      state: 'done',
      run: 'e/eval-pi/fix-sum-1',
      exitCode: 0,
      outcome: 'verified',
    },
    session: {
      agent: 'eval-pi',
      harness: 'pi',
      harnessVersion: '0.9.1',
      provider: { baseUrl: 'http://x', model: 'stub', protocol: 'openai-chat' },
    },
    check: { verdict: 'pass', exitCode: 0, durationMs: 800, timedOut: false },
    usage: { inputTokens: 4, outputTokens: 4, requests: 4 },
  });
  assert.deepEqual(record, {
    schemaVersion: 1,
    suite: 'smoke',
    task: 'fix-sum',
    arm: 'single-pi',
    kind: 'single',
    trial: 1,
    config: {
      agent: 'pi',
      strategy: 'single',
      candidateCount: 1,
      agents: [
        {
          name: 'eval-pi',
          harness: 'pi',
          harnessVersion: '0.9.1',
          provider: { protocol: 'openai-chat', model: 'stub' },
        },
      ],
      model: 'stub',
      e: { version: '1.0.0', commit: 'abc' },
      taskDigest: 'sha256:t',
      verify: null,
      timeoutMs: 7_200_000,
    },
    startedAt: '2026-10-01T10:00:00.000Z',
    latencyMs: 4200,
    exitCode: 0,
    timedOut: false,
    final: {
      branch: 'e/eval-pi/fix-sum-1',
      outcome: 'verified',
      reason: null,
      verify: 'green',
      check: { verdict: 'pass', exitCode: 0, durationMs: 800, timedOut: false },
    },
    candidates: [],
    select: null,
    usage: { inputTokens: 4, outputTokens: 4, requests: 4 },
    records: { ledger: 'man-01', fusion: null },
  });
});

test('singleTrialRecord: an ungated run has no verify; a run that never got a branch is not checked', () => {
  const record = singleTrialRecord({
    suite: 's',
    task: 't',
    arm: { name: 'a', kind: 'single', agent: 'pi' },
    trial: 2,
    config,
    run: { startedAt: 'x', latencyMs: 1, exitCode: 1, timedOut: false },
    ledger: { id: 'man-02', state: 'failed', run: null, exitCode: 1 },
    check: undefined,
  });
  assert.equal(record.final.verify, null);
  assert.equal(record.final.branch, null);
  assert.deepEqual(record.final.check, { verdict: 'skipped' });
  assert.equal(record.usage, null, 'unknown, never estimated');
  assert.deepEqual(record.config.agents, []);
  // A run that died before the ledger saw it at all.
  const lost = singleTrialRecord({
    suite: 's',
    task: 't',
    arm: { name: 'a', kind: 'single', agent: 'pi' },
    trial: 3,
    config,
    run: { startedAt: 'x', latencyMs: 1, exitCode: 1, timedOut: true },
  });
  assert.equal(lost.final.outcome, 'no-record');
  assert.equal(lost.records.ledger, null);
});

test('singleTrialRecord: the loop verdict maps to the verify column', () => {
  const verify = (outcome, reason) =>
    singleTrialRecord({
      suite: 's',
      task: 't',
      arm: { name: 'a', kind: 'single', agent: 'pi' },
      trial: 1,
      config,
      run: { startedAt: 'x', latencyMs: 1, exitCode: 0, timedOut: false },
      ledger: { id: 'm', state: 'done', run: 'b', outcome, reason },
    }).final.verify;
  assert.equal(verify('verified'), 'green');
  assert.equal(verify('exhausted', 'exhausted:iterations'), 'red');
  assert.equal(verify('aborted', 'aborted:verify-broken'), 'broken');
  assert.equal(verify('aborted', 'aborted:harness-exit'), null);
});

const candidate = (id, over = {}) => ({
  candidate: id,
  agent: 'eval-pi',
  harness: { name: 'pi', version: '0.9.1' },
  provider: { protocol: 'openai-chat', model: 'stub' },
  outcome: 'succeeded',
  branch: `e/eval-pi/fix-sum-${id.slice(-1)}`,
  tip: 'tip',
  verify: { verdict: 'green', attempts: 1 },
  elapsedMs: 1000,
  attempt: 1,
  retryOf: null,
  usage: null,
  ...over,
});

const profileSpec = {
  name: 'eval-pi-pair',
  candidates: ['eval-pi', 'eval-pi'],
  synthesizer: 'eval-pi',
  minUsable: 1,
};

const checked = verdict => ({
  verdict,
  exitCode: verdict === 'pass' ? 0 : 1,
  durationMs: 1,
  timedOut: false,
});

test('fusionTrialRecord: the fusion record, every candidate checked, select and oracle beside the synthesis', () => {
  const record = fusionTrialRecord({
    suite: 'smoke',
    task: 'fix-sum',
    arm: { name: 'fusion-pair', kind: 'fusion', profile: 'pi-pair' },
    trial: 1,
    config,
    profile: profileSpec,
    run: { startedAt: 'x', latencyMs: 9000, exitCode: 0, timedOut: false },
    fusion: {
      fusion: 'fusion-01',
      state: 'completed',
      profile: { strategy: 'parallel-synthesize', ...profileSpec },
      candidates: ['cand-001', 'cand-002', 'cand-003'],
      agents: [
        {
          name: 'eval-pi',
          harness: 'pi',
          harnessVersion: '0.9.1',
          provider: { protocol: 'openai-chat', model: 'stub' },
          skills: [],
        },
      ],
    },
    // Read back in directory order; the record's own order is the truth.
    candidates: [
      candidate('cand-003', { attempt: 2, retryOf: 'cand-002' }),
      candidate('cand-001', { verify: { verdict: 'red', attempts: 3 } }),
      candidate('cand-002', {
        outcome: 'failed',
        branch: null,
        tip: null,
        verify: null,
      }),
    ],
    synthesis: {
      id: 'syn-001',
      agent: 'eval-pi',
      branch: 'e/eval-pi/fix-sum-4',
      exitCode: 0,
      verify: { verdict: 'green', attempts: 1 },
    },
    checks: {
      'e/eval-pi/fix-sum-1': checked('pass'),
      'e/eval-pi/fix-sum-3': checked('fail'),
      'e/eval-pi/fix-sum-4': checked('pass'),
    },
  });
  assert.equal(record.kind, 'fusion');
  assert.equal(record.config.profile, 'pi-pair');
  assert.equal(record.config.strategy, 'parallel-synthesize');
  assert.equal(record.config.candidateCount, 2);
  assert.equal(record.config.synthesizer, 'eval-pi');
  assert.deepEqual(record.config.profileSpec, profileSpec);
  assert.equal(record.config.taskDigest, 'sha256:t');
  assert.equal(record.final.outcome, 'completed');
  assert.equal(record.final.verify, 'green');
  assert.equal(record.final.check.verdict, 'pass');
  // Every attempt, in the record's order, each with its slot, and whether
  // it is the slot's last word.
  assert.deepEqual(
    record.candidates.map(c => [
      c.candidate,
      c.slot,
      c.final,
      c.outcome,
      c.verify,
      c.check.verdict,
    ]),
    [
      ['cand-001', 0, true, 'succeeded', 'red', 'pass'],
      ['cand-002', 1, false, 'failed', null, 'skipped'],
      ['cand-003', 1, true, 'succeeded', 'green', 'fail'],
    ]
  );
  // A judge that picks by the in-run gate would have picked the retry,
  // which the hidden check fails; some candidate did pass it.
  assert.deepEqual(record.select, {
    byVerify: { candidate: 'cand-003', check: 'fail' },
    oracle: true,
  });
  assert.equal(record.records.fusion, 'fusion-01');
  assert.equal(
    record.usage,
    null,
    'unknown, never summed from part of the runs'
  );
});

test("fusionTrialRecord: a fusion that left no record still counts its profile's candidates", () => {
  const record = fusionTrialRecord({
    suite: 's',
    task: 't',
    arm: { name: 'f', kind: 'fusion', profile: 'pi-pair' },
    trial: 1,
    config,
    profile: profileSpec,
    run: { startedAt: 'x', latencyMs: 1, exitCode: 1, timedOut: true },
  });
  assert.equal(record.config.candidateCount, 2);
  assert.equal(record.final.outcome, 'no-record');
  assert.deepEqual(record.candidates, []);
});

test('branchesToCheck: every candidate with commits and the synthesis, once each', () => {
  assert.deepEqual(
    branchesToCheck({
      candidates: [
        { branch: 'b1', tip: 't' },
        { branch: 'b2', tip: null },
        { branch: 'b1', tip: 't' },
      ],
      synthesis: { branch: 's' },
    }),
    ['b1', 's']
  );
  assert.deepEqual(branchesToCheck({}), []);
});

test('selectByVerify: the first green final attempt in slot order; no gate, the first with commits', () => {
  const c = (candidate, tip, verify, verdict) => ({
    candidate,
    tip,
    verify,
    final: true,
    check: { verdict },
  });
  assert.deepEqual(
    selectByVerify([c('a', 't', 'red', 'fail'), c('b', 't', 'green', 'pass')]),
    { candidate: 'b', check: 'pass' }
  );
  // No gate declared: the first candidate with commits.
  assert.deepEqual(
    selectByVerify([c('a', null, null, 'skipped'), c('b', 't', null, 'fail')]),
    { candidate: 'b', check: 'fail' }
  );
  // A gate declared and nothing green: a judge has nothing to pick.
  assert.deepEqual(
    selectByVerify([c('a', 't', 'red', 'pass'), c('b', 't', null, 'pass')]),
    { candidate: null, check: null }
  );
  // A retried attempt is not the slot's answer.
  assert.deepEqual(
    selectByVerify([
      { ...c('a', 't', 'green', 'pass'), final: false },
      c('b', 't', 'green', 'fail'),
    ]),
    { candidate: 'b', check: 'fail' }
  );
  assert.deepEqual(selectByVerify([c('a', null, null, 'skipped')]), {
    candidate: null,
    check: null,
  });
});

test('usageFromModelLog: sums the usage the replies carried; nothing logged is unknown', () => {
  const lines = [
    { dir: 'req', seq: 1 },
    {
      dir: 'res',
      seq: 1,
      body: { usage: { prompt_tokens: 3, completion_tokens: 2 } },
    },
    {
      dir: 'res',
      seq: 2,
      stream: [
        { choices: [] },
        { usage: { input_tokens: 5, output_tokens: 1 } },
      ],
    },
    {
      dir: 'res',
      seq: 3,
      stream: [
        [
          'message_start',
          { message: { usage: { input_tokens: 2, output_tokens: 1 } } },
        ],
      ],
    },
  ];
  assert.deepEqual(usageFromModelLog(lines), {
    inputTokens: 10,
    outputTokens: 4,
    requests: 3,
  });
  // A cost, where a recording proxy's upstream reported one.
  assert.deepEqual(
    usageFromModelLog([
      {
        dir: 'res',
        body: { usage: { input: 1, output: 2, cost: { total: 0.25 } } },
      },
    ]),
    { inputTokens: 1, outputTokens: 2, requests: 1, costUsd: 0.25 }
  );
  assert.equal(usageFromModelLog([]), null);
});

// ---------------------------------------------------------------- aggregate

const trial = (arm, kind, over = {}) => ({
  schemaVersion: 1,
  suite: 's',
  task: 'fix-sum',
  arm,
  kind,
  trial: 1,
  config: {
    strategy: kind === 'fusion' ? 'parallel-synthesize' : 'single',
    candidateCount: kind === 'fusion' ? 2 : 1,
  },
  latencyMs: 1000,
  exitCode: 0,
  final: { verify: 'green', check: { verdict: 'pass' } },
  candidates: [],
  select: null,
  usage: null,
  ...over,
});

test('aggregate: quality, latency, candidate failures and usage per arm, and per task', () => {
  const results = [
    trial('single', 'single', { latencyMs: 1000 }),
    trial('single', 'single', {
      trial: 2,
      latencyMs: 3000,
      final: { verify: 'red', check: { verdict: 'fail' } },
      usage: { inputTokens: 5, outputTokens: 5, requests: 2 },
    }),
    trial('fusion', 'fusion', {
      latencyMs: 8000,
      candidates: [
        { outcome: 'succeeded', final: true },
        { outcome: 'failed', final: true },
        { outcome: 'timed-out', final: true },
        { outcome: 'empty', final: true },
        { outcome: 'canceled', final: true },
        // Retried: the slot's later attempt is its answer.
        { outcome: 'failed', final: false },
      ],
      select: {
        byVerify: { candidate: 'cand-001', check: 'fail' },
        oracle: true,
      },
    }),
  ];
  const agg = aggregate(results);
  const single = agg.arms.find(a => a.arm === 'single');
  assert.deepEqual(single, {
    arm: 'single',
    kind: 'single',
    strategy: 'single',
    trials: 2,
    checkPassRate: 0.5,
    verifyGreenRate: 0.5,
    exitZeroRate: 1,
    latencyMs: { mean: 2000, p50: 2000, max: 3000 },
    candidateCount: 1,
    candidateFailureRate: null,
    selectByVerifyPassRate: null,
    oraclePassRate: null,
    usage: { trialsWithUsage: 1, inputTokens: 5, outputTokens: 5, requests: 2 },
  });
  const fusion = agg.arms.find(a => a.arm === 'fusion');
  assert.equal(fusion.candidateCount, 2);
  // Per slot: failed, timed-out and canceled count; empty is an answer.
  assert.equal(fusion.candidateFailureRate, 0.6);
  assert.equal(fusion.selectByVerifyPassRate, 0);
  assert.equal(fusion.oraclePassRate, 1);
  assert.equal(fusion.usage, 'unavailable');
  assert.deepEqual(
    agg.tasks.map(t => [t.task, t.arm, t.trials, t.checkPassRate]),
    [
      ['fix-sum', 'fusion', 1, 1],
      ['fix-sum', 'single', 2, 0.5],
    ]
  );
});

test('aggregate: a verify rate only over trials that had a gate', () => {
  const agg = aggregate([
    trial('a', 'single', {
      final: { verify: null, check: { verdict: 'pass' } },
    }),
  ]);
  assert.equal(agg.arms[0].verifyGreenRate, null);
});

test('renderSummary: one row per arm, unknowns spelled out', () => {
  const md = renderSummary(
    aggregate([
      trial('single', 'single'),
      trial('fusion', 'fusion', {
        select: { byVerify: { candidate: null, check: null }, oracle: false },
      }),
    ]),
    { suite: 's', model: 'stub' }
  );
  assert.match(md, /^# Evaluation: s \(model stub\)/);
  assert.match(md, /\| fusion \| parallel-synthesize \| 1 \| 100% \|/);
  assert.match(md, /\| single \| single \| 1 \| 100% \|/);
  assert.match(md, /unavailable/);
});
