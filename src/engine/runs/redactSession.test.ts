import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  MIN_SECRET_LENGTH,
  redactSessionDir,
  secretsToRedact,
} from './redactSession.js';

// #205: every harness records tool output in its session, and the session
// outlives the run in the Store (ADR-0017). An agent that ran `env` wrote the
// key it was given into it; the host knows every value it delivered and masks
// them before the session is kept.

const KEY = 'sk-run-9f8e7d6c5b4a';
const TOKEN = 'ghp_mcpTokenValue123';

/** Every byte under `dir`, concatenated, for a "nowhere in it" assertion. */
function allBytes(dir: string): string {
  let out = '';
  for (const entry of fs.readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile()) {
      out += fs
        .readFileSync(path.join(entry.parentPath, entry.name))
        .toString('latin1');
    }
  }
  return out;
}

function withDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-redact-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('secretsToRedact: unique, long enough to be a secret, longest first', () => {
  assert.deepEqual(
    secretsToRedact([KEY, undefined, '', '1', 'true', KEY, `${KEY}-longer`]),
    [`${KEY}-longer`, KEY]
  );
  assert.equal(MIN_SECRET_LENGTH, 8);
});

test('redactSessionDir: a JSONL transcript keeps its shape, the values are masked', () => {
  withDir(dir => {
    const nested = path.join(dir, 'projects', '-workspace');
    fs.mkdirSync(nested, { recursive: true });
    const line = JSON.stringify({
      type: 'tool_result',
      content: `OPENAI_API_KEY=${KEY}\nGITHUB_TOKEN=${TOKEN}\nHOME=/home/node`,
    });
    const file = path.join(nested, 'session.jsonl');
    fs.writeFileSync(file, `${line}\n${line}\n`);
    fs.writeFileSync(path.join(dir, 'clean.txt'), 'nothing here\n');

    const redacted = redactSessionDir(dir, [KEY, TOKEN]);

    assert.equal(redacted, 4);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes(KEY) && !text.includes(TOKEN));
    // Same length, so every line still parses and nothing else moved.
    for (const row of text.trim().split('\n')) {
      const parsed = JSON.parse(row) as { content: string };
      assert.match(parsed.content, /^OPENAI_API_KEY=\*+\nGITHUB_TOKEN=\*+\n/);
      assert.match(parsed.content, /HOME=\/home\/node$/);
    }
    assert.equal(
      fs.readFileSync(path.join(dir, 'clean.txt'), 'utf8'),
      'nothing here\n'
    );
  });
});

test('redactSessionDir: a SQLite session (opencode) is masked through SQL, WAL and free pages included', () => {
  withDir(dir => {
    const file = path.join(dir, 'opencode.db');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE part (id INTEGER PRIMARY KEY, data TEXT, n INTEGER)');
    db.exec('CREATE INDEX part_data ON part (data)');
    const insert = db.prepare('INSERT INTO part (data, n) VALUES (?, ?)');
    insert.run(`{"output":"KEY=${KEY}"}`, 1);
    insert.run('{"output":"clean"}', 2);
    // A row deleted before the run ended leaves its bytes on a free page.
    insert.run(`gone ${TOKEN}`, 3);
    db.exec('DELETE FROM part WHERE n = 3');
    db.close();

    redactSessionDir(dir, [KEY, TOKEN]);

    assert.ok(!allBytes(dir).includes(KEY), 'no key in db, wal or shm');
    assert.ok(!allBytes(dir).includes(TOKEN), 'no token on a free page');
    const reopened = new DatabaseSync(file);
    try {
      const rows = reopened
        .prepare('SELECT data, n FROM part ORDER BY n')
        .all() as { data: string; n: number }[];
      assert.deepEqual(
        rows.map(r => r.n),
        [1, 2]
      );
      assert.equal(rows[0].data, `{"output":"KEY=${'*'.repeat(KEY.length)}"}`);
      assert.deepEqual(
        { ...reopened.prepare('PRAGMA integrity_check').get() },
        {
          integrity_check: 'ok',
        }
      );
    } finally {
      reopened.close();
    }
  });
});

test('redactSessionDir: nothing to redact, or no dir, changes nothing', () => {
  withDir(dir => {
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, '{"a":1}\n');
    const before = fs.statSync(file).mtimeMs;
    assert.equal(redactSessionDir(dir, []), 0);
    assert.equal(redactSessionDir(dir, [KEY]), 0);
    assert.equal(fs.statSync(file).mtimeMs, before);
    assert.equal(redactSessionDir(path.join(dir, 'missing'), [KEY]), 0);
  });
});
