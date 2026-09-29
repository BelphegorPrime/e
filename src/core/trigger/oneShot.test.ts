import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseRefCandidates,
  branchOfRef,
  isPullRef,
  requirePayloadFree,
  tickStamp,
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

test('tickStamp: minute-granular, UTC, compact', () => {
  assert.equal(
    tickStamp(new Date('2026-09-18T03:00:42.123Z')),
    '20260918T0300Z'
  );
});

test('baseRefCandidates: a short name is looked up in the target repository only', () => {
  assert.deepEqual(baseRefCandidates('main'), {
    ok: true,
    candidates: [
      'refs/heads/main',
      'refs/remotes/origin/main',
      'refs/tags/main',
    ],
  });
  assert.deepEqual(baseRefCandidates('origin/release/1.x'), {
    ok: true,
    candidates: ['refs/remotes/origin/release/1.x'],
  });
});

test('baseRefCandidates: a full ref is taken as written, when it is the target repository', () => {
  assert.deepEqual(baseRefCandidates('refs/heads/dev'), {
    ok: true,
    candidates: ['refs/heads/dev'],
  });
  assert.deepEqual(baseRefCandidates('refs/remotes/origin/dev'), {
    ok: true,
    candidates: ['refs/remotes/origin/dev'],
  });
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
  assert.equal(branchOfRef('refs/heads/main'), 'main');
  assert.equal(branchOfRef('refs/remotes/origin/release/1.x'), 'release/1.x');
  assert.equal(branchOfRef('refs/tags/v1'), 'v1');
});
