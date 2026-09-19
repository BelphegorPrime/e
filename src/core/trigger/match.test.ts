import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesEvent } from './match.js';
import type { TriggerOn } from './index.js';

/*
 * Filtering (ADR-0016). Exact match only: the payload is attacker-controlled,
 * and anything that evaluates expressions evaluates them against a stranger's
 * data. Without any filter, every label click on every issue would start a
 * container and take a queue slot - a denial of service against your own
 * queue, paid for at the provider.
 */

const on: TriggerOn = {
  type: 'webhook',
  source: 'github',
  event: 'issues',
  action: 'labeled',
  match: { 'label.name': 'agent' },
};

const event = {
  name: 'issues',
  payload: {
    action: 'labeled',
    label: { name: 'agent' },
    issue: { number: 42 },
  },
};

test('matchesEvent: name, action and every match path must agree', () => {
  assert.equal(matchesEvent(on, event), true);
});

test('matchesEvent: a different event or action is no match', () => {
  assert.equal(matchesEvent(on, { ...event, name: 'push' }), false);
  assert.equal(
    matchesEvent(on, {
      ...event,
      payload: { ...event.payload, action: 'opened' },
    }),
    false
  );
});

test('matchesEvent: an undeclared action matches any action', () => {
  const anyAction: TriggerOn = {
    type: 'webhook',
    source: 'github',
    event: 'issues',
  };
  assert.equal(matchesEvent(anyAction, event), true);
  assert.equal(
    matchesEvent(anyAction, {
      ...event,
      payload: { ...event.payload, action: 'closed' },
    }),
    true
  );
});

test('matchesEvent: a list of values is OR, and every path is ANDed', () => {
  const several: TriggerOn = {
    type: 'webhook',
    source: 'github',
    event: 'issues',
    match: { 'label.name': ['agent', 'autofix'], 'issue.number': '42' },
  };
  assert.equal(matchesEvent(several, event), true);
  assert.equal(
    matchesEvent(several, {
      ...event,
      payload: { ...event.payload, label: { name: 'wontfix' } },
    }),
    false
  );
});

test('matchesEvent: a path the payload does not have is simply no match', () => {
  // Not an error: a payload shape we did not expect must not take anything
  // down, it must just not fire.
  const missing: TriggerOn = {
    type: 'webhook',
    source: 'github',
    event: 'issues',
    match: { 'pull_request.head.ref': 'main' },
  };
  assert.equal(matchesEvent(missing, event), false);
});

test('matchesEvent: numbers compare as the text they are written as', () => {
  const byNumber: TriggerOn = {
    type: 'webhook',
    source: 'github',
    event: 'issues',
    match: { 'issue.number': '42' },
  };
  assert.equal(matchesEvent(byNumber, event), true);
});

test('matchesEvent: a clock never matches a delivery', () => {
  const cron: TriggerOn = { type: 'cron', expr: '0 3 * * *' };
  assert.equal(matchesEvent(cron, event), false);
});
