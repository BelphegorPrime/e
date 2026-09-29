import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseRefCandidates,
  branchOfRef,
  isPullRef,
  oneShotEvent,
  oneShotRefusal,
  renderBaseName,
  renderOneShotPrompt,
  requirePayloadFree,
  requireSameBase,
} from './oneShot.js';
import type { Trigger } from './index.js';
import { payloadReferences } from './prompt.js';

/*
 * The one-shot shape's pure rules (ADR-0016 section 13): which templates need
 * a payload, how a declared `base` becomes a ref in the target repository, and
 * what `{{tick}}` reads when no scheduler supplies one.
 */

const trigger: Trigger = {
  name: 'fix-issue',
  enabled: true,
  agent: 'claude-pr',
  prompt: 'Fix it.',
  overlap: 'skip',
  on: { type: 'webhook', source: 'github', event: 'issues' },
};

test('payloadReferences: host values are not payload paths', () => {
  assert.deepEqual(
    payloadReferences('{{trigger}} at {{ tick }}: fix #{{issue.number}}'),
    ['issue.number']
  );
  assert.deepEqual(payloadReferences('no placeholders'), []);
});

test('requirePayloadFree: a payload-free trigger passes', () => {
  requirePayloadFree({ ...trigger, prompt: 'Run {{trigger}} at {{tick}}.' });
});

test('requirePayloadFree: a prompt referencing the payload fails, naming the field', () => {
  assert.throws(
    () => requirePayloadFree({ ...trigger, prompt: 'Fix #{{issue.number}}.' }),
    /"prompt" references \{\{issue\.number\}\}.*--event/
  );
});

test('requirePayloadFree: a base referencing the payload fails, naming the field', () => {
  assert.throws(
    () => requirePayloadFree({ ...trigger, base: '{{pull_request.head.ref}}' }),
    /"base" references \{\{pull_request\.head\.ref\}\}/
  );
});

test("baseRefCandidates: a short name is looked up as origin's branch, then as a tag", () => {
  assert.deepEqual(baseRefCandidates('main'), {
    ok: true,
    candidates: ['refs/remotes/origin/main', 'refs/tags/main'],
  });
  assert.deepEqual(baseRefCandidates('origin/release/1.x'), {
    ok: true,
    candidates: ['refs/remotes/origin/release/1.x'],
  });
});

test('baseRefCandidates: a full ref is taken as written, when it is the target repository', () => {
  assert.deepEqual(baseRefCandidates('refs/remotes/origin/dev'), {
    ok: true,
    candidates: ['refs/remotes/origin/dev'],
  });
  assert.deepEqual(baseRefCandidates('refs/tags/v1'), {
    ok: true,
    candidates: ['refs/tags/v1'],
  });
});

test('baseRefCandidates: a local branch is this machine, not the target repository', () => {
  // `gh pr checkout` makes one out of a fork's head.
  const out = baseRefCandidates('refs/heads/main');
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.reason : '', /local branch.*origin\/main/);
});

test('baseRefCandidates: refs/pull/* is refused explicitly', () => {
  const out = baseRefCandidates('refs/pull/42/head');
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.reason : '', /refs\/pull/);
});

test('baseRefCandidates: another remote, a leading dash and an empty name are refused', () => {
  for (const name of [
    'refs/remotes/fork/main',
    '--output=x',
    '',
    'refs/notes/x',
  ]) {
    assert.equal(baseRefCandidates(name).ok, false, name);
  }
});

test('isPullRef: every spelling of a pull request ref', () => {
  assert.equal(isPullRef('refs/pull/1/head'), true);
  assert.equal(isPullRef('refs/remotes/pull/1/merge'), true);
  assert.equal(isPullRef('refs/remotes/origin/pull/1/head'), true);
  assert.equal(isPullRef('refs/remotes/origin/main'), false);
  assert.equal(isPullRef('refs/heads/pull-request-fixes'), false);
});

test('branchOfRef: the branch a pull request would target', () => {
  assert.equal(branchOfRef('refs/remotes/origin/release/1.x'), 'release/1.x');
  assert.equal(branchOfRef('refs/tags/v1'), 'v1');
});

// --- the decisions, pure: the engine only reads and hands them the results ---

const labeled: Trigger = {
  ...trigger,
  prompt: 'Fix #{{issue.number}}.',
  on: {
    type: 'webhook',
    source: 'github',
    event: 'issues',
    action: 'labeled',
    match: { 'label.name': 'agent' },
  },
};
const payload = {
  action: 'labeled',
  label: { name: 'agent' },
  issue: { number: 42 },
  pull_request: { head: { ref: 'feature' } },
};
const cron: Trigger = {
  ...trigger,
  prompt: 'Nightly at {{tick}}.',
  on: { type: 'cron', expr: '0 3 * * *', tz: 'Europe/Berlin' },
};

test('oneShotEvent: a webhook trigger keeps the payload and its name', () => {
  assert.deepEqual(oneShotEvent(labeled, payload, 'issues'), {
    event: { payload, name: 'issues' },
    warnings: [],
  });
});

test('oneShotEvent: a cron trigger drops any payload and says its schedule is ignored', () => {
  const out = oneShotEvent(cron, payload, 'schedule');
  assert.deepEqual(out.event, {});
  assert.equal(out.warnings.length, 2);
  assert.match(out.warnings.join('\n'), /--event is ignored/);
  assert.match(out.warnings.join('\n'), /expr and tz are ignored/);
  assert.equal(oneShotEvent(cron, undefined, undefined).warnings.length, 1);
});

test('oneShotRefusal: a match runs, a non-match or a disabled trigger is a skip', () => {
  assert.equal(oneShotRefusal(labeled, { payload, name: 'issues' }), undefined);
  assert.match(
    oneShotRefusal(labeled, { payload, name: 'pull_request' }) ?? '',
    /does not match/
  );
  assert.match(
    oneShotRefusal({ ...labeled, enabled: false }, {}) ?? '',
    /disabled/
  );
});

test('oneShotRefusal: no payload runs when the trigger needs none, and throws when it does', () => {
  assert.equal(
    oneShotRefusal({ ...labeled, prompt: 'Fix it.' }, {}),
    undefined
  );
  assert.throws(() => oneShotRefusal(labeled, {}), /"prompt" references/);
  assert.throws(() => oneShotRefusal(labeled, { payload }), /--event-name/);
});

test('renderBaseName: undefined without a base, rendered with one, a base error on a bad value', () => {
  assert.equal(renderBaseName(labeled, { payload }, 'tick'), undefined);
  const fromPr = { ...labeled, base: '{{pull_request.head.ref}}' };
  assert.equal(renderBaseName(fromPr, { payload }, 'tick'), 'feature');
  assert.throws(
    () =>
      renderBaseName(
        fromPr,
        { payload: { pull_request: { head: { ref: 'a;b' } } } },
        'tick'
      ),
    /^Error: Base error: "base": /
  );
});

test('requireSameBase: the declaration at base must name the base it was read from', () => {
  const declared = { ...labeled, base: 'dev' };
  requireSameBase(
    declared,
    declared,
    'refs/remotes/origin/dev',
    'refs/remotes/origin/main'
  );
  assert.throws(
    () =>
      requireSameBase(
        { ...declared, base: 'other' },
        declared,
        'refs/remotes/origin/dev',
        'refs/remotes/origin/main'
      ),
    /Base error: .*declares base "other".*must agree/
  );
});

test('renderOneShotPrompt: renders the whitelist, and names the field when it cannot', () => {
  assert.equal(
    renderOneShotPrompt(labeled, { payload }, '20260918T0300Z'),
    'Fix #42.'
  );
  assert.equal(
    renderOneShotPrompt(cron, {}, '20260918T0300Z'),
    'Nightly at 20260918T0300Z.'
  );
  assert.throws(
    () =>
      renderOneShotPrompt(
        { ...labeled, prompt: 'Do {{issue.title}}' },
        { payload },
        't'
      ),
    /Trigger "fix-issue": "prompt": .*not interpolable/
  );
});
