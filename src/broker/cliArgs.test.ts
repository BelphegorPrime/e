import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPAWN_BROTHER_USAGE,
  brokerBaseUrl,
  parseSpawnBrotherArgs,
} from './cliArgs.js';

test('parseSpawnBrotherArgs: no args or -h/--help is help', () => {
  assert.deepEqual(parseSpawnBrotherArgs([]), { kind: 'help' });
  assert.deepEqual(parseSpawnBrotherArgs(['-h']), { kind: 'help' });
  assert.deepEqual(parseSpawnBrotherArgs(['--help']), { kind: 'help' });
  assert.match(SPAWN_BROTHER_USAGE, /--status/);
});

test('parseSpawnBrotherArgs: --status lists all or one sibling', () => {
  assert.deepEqual(parseSpawnBrotherArgs(['--status']), { kind: 'status' });
  assert.deepEqual(parseSpawnBrotherArgs(['--status', 'sib-001']), {
    kind: 'status',
    id: 'sib-001',
  });
  assert.throws(
    () => parseSpawnBrotherArgs(['--status', 'a', 'b']),
    /at most one/
  );
});

test('parseSpawnBrotherArgs: <agent> <words...> is a spawn with the words joined', () => {
  assert.deepEqual(parseSpawnBrotherArgs(['researcher', 'look', 'into', 'X']), {
    kind: 'spawn',
    agent: 'researcher',
    prompt: 'look into X',
  });
  assert.throws(
    () => parseSpawnBrotherArgs(['researcher']),
    /task description/
  );
  assert.throws(() => parseSpawnBrotherArgs(['--bogus']), /Unknown option/);
});

test('brokerBaseUrl: reads $E_BROKER_URL without a trailing slash; unset is an error', () => {
  assert.equal(
    brokerBaseUrl({ E_BROKER_URL: 'http://runtime-broker:20130/' }),
    'http://runtime-broker:20130'
  );
  assert.equal(
    brokerBaseUrl({ E_BROKER_URL: ' http://localhost:20130 ' }),
    'http://localhost:20130'
  );
  assert.throws(() => brokerBaseUrl({}), /\$E_BROKER_URL is not set/);
});

test('parseSpawnBrotherArgs: --merge <id> signals one sibling; the id is required, and only one', () => {
  assert.deepEqual(parseSpawnBrotherArgs(['--merge', 'sib-001']), {
    kind: 'merge',
    id: 'sib-001',
  });
  assert.throws(() => parseSpawnBrotherArgs(['--merge']), /exactly one/);
  assert.throws(
    () => parseSpawnBrotherArgs(['--merge', 'a', 'b']),
    /exactly one/
  );
  assert.match(SPAWN_BROTHER_USAGE, /--merge <id>/);
});
