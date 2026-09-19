import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triggerListLines } from './index.js';

/*
 * `e trigger list` (ADR-0016). A trigger that has never fired is invisible in
 * the run list - which is exactly the "why is my schedule not running?" case -
 * so this is where that question gets an answer, and where a load error is
 * shown. That makes the command the linter for trigger files.
 */

test('triggerListLines: an enabled trigger shows its source at a glance', () => {
  const [line] = triggerListLines([
    {
      name: 'nightly',
      trigger: {
        name: 'nightly',
        enabled: true,
        agent: 'claude-pr',
        prompt: 'p',
        overlap: 'skip',
        on: { type: 'cron', expr: '0 3 * * *', tz: 'Europe/Berlin' },
      },
    },
  ]);
  assert.match(line.text, /nightly/);
  assert.match(line.text, /claude-pr/);
  assert.match(line.text, /0 3 \* \* \*/);
  assert.match(line.text, /Europe\/Berlin/);
});

test('triggerListLines: disabled and failed-to-load are different diagnoses', () => {
  const lines = triggerListLines([
    {
      name: 'off',
      trigger: {
        name: 'off',
        enabled: false,
        agent: 'a',
        prompt: 'p',
        overlap: 'skip',
        on: { type: 'webhook', source: 'github', event: 'issues' },
      },
    },
    { name: 'broken', error: 'no trigger.json in broken/' },
  ]);
  assert.match(lines[0].text, /disabled/i);
  assert.equal(lines[0].level, 'info');
  assert.match(lines[1].text, /no trigger\.json/);
  assert.equal(lines[1].level, 'warn', 'a broken trigger is not merely off');
});

test('triggerListLines: an empty store says so rather than printing nothing', () => {
  const [line] = triggerListLines([]);
  assert.match(line.text, /no triggers/i);
});
