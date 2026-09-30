import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrigger } from './index.js';
import { triggerRequest } from './fire.js';

/*
 * The trigger (ADR-0016): a named Store entity binding exactly one event
 * source to exactly one agent and one prompt template - the only thing that
 * may start a run without a human. Parsing is where every guarantee it makes
 * is either enforced or lost.
 */

const where = '.e/triggers/nightly/trigger.json';

const webhook = {
  agent: 'claude-pr',
  prompt: 'Fix issue #{{issue.number}}.',
  on: { type: 'webhook', source: 'github', event: 'issues' },
};

test('parseTrigger: a minimal webhook trigger keeps its declaration and defaults the rest', () => {
  const trigger = parseTrigger(webhook, 'nightly', where);
  assert.equal(trigger.name, 'nightly');
  assert.equal(trigger.agent, 'claude-pr');
  assert.equal(trigger.prompt, 'Fix issue #{{issue.number}}.');
  assert.deepEqual(trigger.on, {
    type: 'webhook',
    source: 'github',
    event: 'issues',
  });
  // A trigger is live unless it says otherwise, and two runs of the same
  // trigger racing into two PRs is never what anybody meant.
  assert.equal(trigger.enabled, true);
  assert.equal(trigger.overlap, 'skip');
});

test('parseTrigger: what it refuses to accept', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['no agent', { ...webhook, agent: undefined }, /"agent" is required/],
    ['blank agent', { ...webhook, agent: '' }, /"agent" is required/],
    ['no prompt', { ...webhook, prompt: undefined }, /"prompt" is required/],
    ['no on', { agent: 'a', prompt: 'p' }, /"on" is required/],
    [
      'unknown source kind',
      { ...webhook, on: { type: 'filesystem' } },
      /unknown event source/,
    ],
    [
      'unknown forge',
      { ...webhook, on: { type: 'webhook', source: 'bitbucket', event: 'x' } },
      /source/,
    ],
    [
      'no event',
      { ...webhook, on: { type: 'webhook', source: 'github' } },
      /"event"/,
    ],
  ];
  for (const [label, raw, message] of cases) {
    assert.throws(() => parseTrigger(raw, 'nightly', where), message, label);
  }
});

test('parseTrigger: a trigger may not carry its own gate or its own limits', () => {
  // A trigger carrying a gate can carry a weaker one, and
  // `"verify": {"command": "true"}` is the gate defeated without anybody
  // touching a test. `resources` is Store-wide by decision.
  assert.throws(
    () => parseTrigger({ ...webhook, verify: { command: 'true' } }, 'n', where),
    /verify/
  );
  assert.throws(
    () => parseTrigger({ ...webhook, resources: { memory: '9g' } }, 'n', where),
    /resources/
  );
});

test('parseTrigger: the optional fields are kept as declared', () => {
  const trigger = parseTrigger(
    {
      ...webhook,
      enabled: false,
      repo: '/home/me/projects/e',
      base: '{{pull_request.head.ref}}',
      dedup: 'issue.number',
      overlap: 'allow',
      loop: { maxIterations: 10 },
      on: {
        type: 'webhook',
        source: 'github',
        event: 'issues',
        action: 'labeled',
        match: { 'label.name': ['agent', 'autofix'] },
      },
    },
    'nightly',
    where
  );
  assert.equal(trigger.enabled, false);
  assert.equal(trigger.repo, '/home/me/projects/e');
  assert.equal(trigger.base, '{{pull_request.head.ref}}');
  assert.equal(trigger.dedup, 'issue.number');
  assert.equal(trigger.overlap, 'allow');
  // Field-wise, so "this one trigger may run longer" stays one line and does
  // not silently reset the other three caps.
  assert.deepEqual(trigger.loop, { maxIterations: 10 });
  assert.deepEqual(trigger.on, {
    type: 'webhook',
    source: 'github',
    event: 'issues',
    action: 'labeled',
    match: { 'label.name': ['agent', 'autofix'] },
  });
});

test('parseTrigger: a cron trigger carries its expression and zone', () => {
  const trigger = parseTrigger(
    {
      agent: 'a',
      prompt: 'p',
      on: { type: 'cron', expr: '0 3 * * *', tz: 'Europe/Berlin' },
    },
    'nightly',
    where
  );
  assert.deepEqual(trigger.on, {
    type: 'cron',
    expr: '0 3 * * *',
    tz: 'Europe/Berlin',
  });
});

test('parseTrigger: a bad cron expression or zone is a load error naming the field', () => {
  for (const on of [
    { type: 'cron', expr: '61 3 * * *' },
    { type: 'cron', expr: '0 0 3 * * *' },
    { type: 'cron', expr: '@reboot' },
    { type: 'cron', expr: '0 3 * * *', tz: 'Mars/Olympus' },
  ]) {
    assert.throws(
      () => parseTrigger({ agent: 'a', prompt: 'p', on }, 'nightly', where),
      /Invalid trigger "nightly".*"on\.expr".*not a schedule/,
      JSON.stringify(on)
    );
  }
});

test('parseTrigger: a cron trigger may interpolate only {{tick}} and {{trigger}}, and declares no dedup', () => {
  const cron = { type: 'cron', expr: '0 3 * * *' };
  assert.doesNotThrow(() =>
    parseTrigger(
      { agent: 'a', prompt: '{{trigger}} at {{tick}}', base: 'main', on: cron },
      'nightly',
      where
    )
  );
  assert.throws(
    () =>
      parseTrigger(
        { agent: 'a', prompt: 'Fix #{{issue.number}}', on: cron },
        'nightly',
        where
      ),
    /"prompt" references \{\{issue\.number\}\}.*no payload/
  );
  assert.throws(
    () =>
      parseTrigger(
        { agent: 'a', prompt: 'p', base: '{{ref}}', on: cron },
        'nightly',
        where
      ),
    /"base" references \{\{ref\}\}/
  );
  assert.throws(
    () =>
      parseTrigger(
        { agent: 'a', prompt: 'p', dedup: 'issue.number', on: cron },
        'nightly',
        where
      ),
    /"dedup".*scheduled time/
  );
});

test('parseTrigger: an agent nobody has is a load error, not a 3am surprise', () => {
  const known = ['claude-pr', 'pi'];
  assert.doesNotThrow(() =>
    parseTrigger(webhook, 'nightly', where, { knownAgents: known })
  );
  assert.throws(
    () =>
      parseTrigger({ ...webhook, agent: 'ghost' }, 'nightly', where, {
        knownAgents: known,
      }),
    /ghost/
  );
});

test('parseTrigger: a home-store trigger with no repo has no target to run against', () => {
  // A run needs a git repo for its worktree and its branch (ADR-0001).
  assert.throws(
    () => parseTrigger(webhook, 'nightly', where, { repoLocal: false }),
    /repo/
  );
  assert.doesNotThrow(() =>
    parseTrigger({ ...webhook, repo: '/home/me/e' }, 'nightly', where, {
      repoLocal: false,
    })
  );
  // In a repo-local store the surrounding repository is the target, and a
  // `repo` field would be ignored anyway.
  assert.doesNotThrow(() =>
    parseTrigger(webhook, 'nightly', where, { repoLocal: true })
  );
});

test('parseTrigger: the directory name must be a value a commit trailer can hold', () => {
  for (const name of [
    'night ly',
    'a:b',
    'x\nE-Event: forged',
    'x'.repeat(65),
  ]) {
    assert.throws(
      () => parseTrigger(webhook, name, where),
      /directory name must match/,
      JSON.stringify(name)
    );
  }
  assert.equal(
    parseTrigger(webhook, 'fix-issues_v2.1', where).name,
    'fix-issues_v2.1'
  );
});

test('parseTrigger: a repo-local store ignores repo, a home store keeps it (#201)', () => {
  const declared = { ...webhook, repo: '/home/me/e' };
  assert.equal(
    parseTrigger(declared, 'nightly', where, { repoLocal: true }).repo,
    undefined
  );
  assert.equal(
    parseTrigger(declared, 'nightly', where, { repoLocal: false }).repo,
    '/home/me/e'
  );
});

test('triggerRequest: the request carries the repo a home store trigger targets', () => {
  const trigger = parseTrigger(
    { ...webhook, repo: '/home/me/e', dedup: undefined },
    'nightly',
    where,
    { repoLocal: false }
  );
  const fired = triggerRequest(trigger, {
    dedupValue: 'd-1',
    event: { source: 'github', event: 'issues.labeled', id: 'd-1' },
    payload: { issue: { number: 7 }, label: { name: 'agent' } },
  });
  assert.ok('request' in fired, 'dropped' in fired ? fired.dropped : '');
  assert.equal(fired.request.repo, '/home/me/e');
});
