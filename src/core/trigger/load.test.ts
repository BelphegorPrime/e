import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadTriggers, type LoadedTrigger } from './load.js';

/*
 * Loading (ADR-0016). One bad trigger must not take the Store down: a typo
 * cannot be allowed to stop the BFF, the webhook listener and four healthy
 * triggers, and a detached `serve` that refuses to start is the least
 * diagnosable failure this system can produce.
 */

function withStore(
  triggers: Record<string, Record<string, string>>,
  fn: (root: string) => void
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-triggers-'));
  try {
    for (const [name, files] of Object.entries(triggers)) {
      const dir = path.join(root, '.e', 'triggers', name);
      fs.mkdirSync(dir, { recursive: true });
      for (const [file, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, file), body);
      }
    }
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const valid = JSON.stringify({
  agent: 'claude-pr',
  prompt: 'Fix it.',
  on: { type: 'webhook', source: 'github', event: 'issues' },
});

test('loadTriggers: a Store with no triggers directory loads nothing and says nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-triggers-'));
  try {
    assert.deepEqual(loadTriggers(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadTriggers: the directory name is the id', () => {
  withStore({ nightly: { 'trigger.json': valid } }, root => {
    const loaded = loadTriggers(root);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].name, 'nightly');
    assert.equal(loaded[0].trigger?.agent, 'claude-pr');
    assert.equal(loaded[0].error, undefined);
  });
});

test('loadTriggers: prompt.md is the prompt when the json declares none', () => {
  withStore(
    {
      nightly: {
        'trigger.json': JSON.stringify({
          agent: 'a',
          on: { type: 'cron', expr: '0 3 * * *' },
        }),
        'prompt.md': '# Nightly\n\nRun the suite.\n',
      },
    },
    root => {
      assert.match(
        loadTriggers(root)[0].trigger?.prompt ?? '',
        /Run the suite/
      );
    }
  );
});

test('loadTriggers: declaring the prompt twice is refused rather than silently preferred', () => {
  withStore(
    {
      nightly: {
        'trigger.json': valid,
        'prompt.md': 'something else entirely',
      },
    },
    root => {
      assert.match(loadTriggers(root)[0].error ?? '', /prompt/);
    }
  );
});

test('loadTriggers: one broken trigger is marked invalid and the healthy ones still load', () => {
  withStore(
    {
      broken: { 'trigger.json': '{ not json' },
      missing: {},
      wrong: { 'trigger.json': JSON.stringify({ prompt: 'p' }) },
      healthy: { 'trigger.json': valid },
    },
    root => {
      const byName = Object.fromEntries(
        loadTriggers(root).map((t: LoadedTrigger) => [t.name, t])
      );
      assert.match(byName.broken.error ?? '', /JSON|parse/i);
      assert.match(byName.missing.error ?? '', /trigger\.json/);
      assert.match(byName.wrong.error ?? '', /agent/);
      assert.equal(byName.healthy.error, undefined);
      assert.equal(byName.healthy.trigger?.enabled, true);
    }
  );
});

test('loadTriggers: a disabled trigger loads - it is off, not broken', () => {
  withStore(
    {
      off: {
        'trigger.json': JSON.stringify({
          agent: 'a',
          prompt: 'p',
          enabled: false,
          on: { type: 'cron', expr: '@daily' },
        }),
      },
    },
    root => {
      const [loaded] = loadTriggers(root);
      assert.equal(loaded.error, undefined);
      assert.equal(loaded.trigger?.enabled, false);
    }
  );
});
