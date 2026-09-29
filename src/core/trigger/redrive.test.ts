import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Trigger } from './index.js';
import { redriveFire } from './redrive.js';

/*
 * Redrive (ADR-0016 section 6): the payload and nothing else; everything
 * else from the declaration as it is now.
 */

const webhook: Trigger = {
  name: 'fix',
  enabled: true,
  agent: 'pi',
  prompt: 'Fix #{{issue.number}}',
  overlap: 'skip',
  on: { type: 'webhook', source: 'github', event: 'issues', action: 'labeled' },
};

const dead = {
  event: { source: 'github', event: 'issues', id: 'd-1' },
  payload: {
    action: 'labeled',
    issue: { number: 42 },
    label: { name: 'agent' },
  },
};

test('redriveFire: the current prompt template and agent take effect on the old payload', () => {
  const fire = redriveFire(
    {
      ...webhook,
      agent: 'codex',
      prompt: 'Now fix #{{issue.number}} properly',
    },
    dead
  );
  assert.ok('request' in fire);
  assert.equal(fire.request.agent, 'codex');
  assert.equal(fire.request.prompt, 'Now fix #42 properly');
  assert.equal(fire.request.key, 'fix:d-1');
  assert.deepEqual(fire.request.payload, dead.payload);
});

test('redriveFire: a match that no longer agrees refuses, and so does a disabled trigger', () => {
  const narrowed = redriveFire(
    {
      ...webhook,
      on: { ...webhook.on, match: { 'label.name': 'bug' } } as Trigger['on'],
    },
    dead
  );
  assert.match((narrowed as { dropped: string }).dropped, /no longer matches/);
  const off = redriveFire({ ...webhook, enabled: false }, dead);
  assert.match((off as { dropped: string }).dropped, /disabled/);
});

test('redriveFire: overlap is not asked - a human is starting it', () => {
  const fire = redriveFire({ ...webhook, overlap: 'skip' }, dead);
  assert.ok('request' in fire);
});

test('redriveFire: a cron request keeps its scheduled tick as key and {{tick}}', () => {
  const fire = redriveFire(
    {
      ...webhook,
      name: 'nightly',
      prompt: 'Sweep {{tick}}',
      on: { type: 'cron', expr: '0 3 * * *' },
    },
    { event: { source: 'cron', event: 'tick', id: '20260918T0300Z' } }
  );
  assert.ok('request' in fire);
  assert.equal(fire.request.key, 'nightly:20260918T0300Z');
  assert.equal(fire.request.prompt, 'Sweep 20260918T0300Z');
});

test('redriveFire: a trigger whose source kind changed refuses', () => {
  const cronNow = redriveFire(
    { ...webhook, on: { type: 'cron', expr: '0 3 * * *' } },
    dead
  );
  assert.match((cronNow as { dropped: string }).dropped, /cron trigger now/);
  const hookNow = redriveFire(webhook, {
    event: { source: 'cron', event: 'tick', id: '20260918T0300Z' },
  });
  assert.match(
    (hookNow as { dropped: string }).dropped,
    /listens to github now/
  );
});
