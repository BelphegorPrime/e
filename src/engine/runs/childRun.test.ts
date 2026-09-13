import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureSpool,
  readStatus,
  spoolLogPath,
  writeRequest,
  writeStatus,
} from '../../sidecars/broker/contract/spool.js';
import type { SpawnRequest } from '../../sidecars/broker/contract/types.js';
import {
  childCliArgs,
  childLogFile,
  logTail,
  settleChildRun,
  startChildRun,
  type ChildHandle,
  type ChildLaunch,
} from './childRun.js';
import { assertCliEntry } from '../../shared/utils/selfInvoke.js';

const request: SpawnRequest = {
  id: 'sib-001',
  agent: 'pi',
  prompt: 'fix the parser',
  requestedAt: '2026-09-13T10:00:00.000Z',
};

const now = (): Date => new Date('2026-09-13T10:05:00.000Z');

/** A spool with `request` already in it, cleaned up after `fn`. */
function withSpool(fn: (spool: string) => void): void {
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), 'e-childrun-'));
  try {
    ensureSpool(spool);
    writeRequest(spool, request);
    fn(spool);
  } finally {
    fs.rmSync(spool, { recursive: true, force: true });
  }
}

test('childCliArgs runs one-shot, with the passthrough before the prompt', () => {
  assert.deepEqual(childCliArgs(request), [
    'spawn',
    'pi',
    '--',
    'fix the parser',
  ]);
  assert.deepEqual(childCliArgs(request, ['--dir', '/repo']), [
    'spawn',
    'pi',
    '--dir',
    '/repo',
    '--',
    'fix the parser',
  ]);
});

test('assertCliEntry refuses to re-invoke anything but the CLI entry', () => {
  assert.deepEqual(
    assertCliEntry({ command: 'node', prefix: ['/e/index.js'] }),
    {
      command: 'node',
      prefix: ['/e/index.js'],
    }
  );
  // A single executable has no entry to pass on.
  assert.deepEqual(
    assertCliEntry({ command: '/usr/local/bin/e', prefix: [] }),
    {
      command: '/usr/local/bin/e',
      prefix: [],
    }
  );
  assert.throws(
    () => assertCliEntry({ command: 'node', prefix: ['/e/dist/some.test.js'] }),
    /not its index\.js entry/
  );
});

test('startChildRun hands the launcher the args, the env and the spool log', () => {
  withSpool(spool => {
    let seen: ChildLaunch | undefined;
    const handle: ChildHandle = {
      exited: Promise.resolve(0),
      kill: () => {},
    };
    startChildRun({
      spoolDir: spool,
      request,
      env: { E_SPAWN_ROLE: 'child' },
      passthroughArgs: ['--dir', '/repo'],
      launch: launch => {
        seen = launch;
        return handle;
      },
    });
    assert.equal(seen?.request, request);
    assert.deepEqual(seen?.args, [
      'spawn',
      'pi',
      '--dir',
      '/repo',
      '--',
      'fix the parser',
    ]);
    assert.deepEqual(seen?.env, { E_SPAWN_ROLE: 'child' });
    assert.equal(seen?.logFile, spoolLogPath(spool, 'sib-001'));
    assert.equal(seen?.spoolDir, spool);
  });
});

test('a cancel keeps everything the run had already reported', () => {
  // The bug this rule exists for: a cancel racing a run that has just
  // finished must not erase where its work went.
  withSpool(spool => {
    writeStatus(spool, 'sib-001', {
      status: 'done',
      branch: 'e/pi/fix-the-parser-1',
      exitCode: 0,
      pushed: true,
      pullRequestUrl: 'https://example.test/pr/7',
      report: 'e-runs/sib-001/report.md',
      updatedAt: '2026-09-13T10:04:00.000Z',
    });
    settleChildRun({
      spoolDir: spool,
      id: 'sib-001',
      code: 0,
      canceling: true,
      actor: 'the parent',
      now,
    });
    assert.deepEqual(readStatus(spool, 'sib-001'), {
      status: 'canceled',
      branch: 'e/pi/fix-the-parser-1',
      exitCode: 0,
      pushed: true,
      pullRequestUrl: 'https://example.test/pr/7',
      report: 'e-runs/sib-001/report.md',
      error: 'canceled by the parent',
      updatedAt: '2026-09-13T10:05:00.000Z',
    });
  });
});

test('a child that never reported fails, keeping the branch it had announced', () => {
  withSpool(spool => {
    writeStatus(spool, 'sib-001', {
      status: 'running',
      branch: 'e/pi/fix-the-parser-1',
      updatedAt: '2026-09-13T10:01:00.000Z',
    });
    settleChildRun({
      spoolDir: spool,
      id: 'sib-001',
      code: 3,
      canceling: false,
      actor: 'the parent',
      now,
    });
    const status = readStatus(spool, 'sib-001');
    assert.equal(status?.status, 'failed');
    assert.equal(status?.exitCode, 3);
    // Without the branch nothing names where the child's work went.
    assert.equal(status?.branch, 'e/pi/fix-the-parser-1');
    assert.match(status?.error ?? '', /exited with code 3 before reporting/);
  });
});

test('the failure message quotes the tail of the child log', () => {
  withSpool(spool => {
    fs.writeFileSync(
      childLogFile(spool, 'sib-001'),
      'building image\nUnknown agent "researcher".\n'
    );
    settleChildRun({
      spoolDir: spool,
      id: 'sib-001',
      code: 2,
      canceling: false,
      actor: 'the parent',
      now,
    });
    assert.match(
      readStatus(spool, 'sib-001')?.error ?? '',
      /building image \| Unknown agent "researcher"\./
    );
  });
});

test('an explicit reason replaces the generic message', () => {
  withSpool(spool => {
    settleChildRun({
      spoolDir: spool,
      id: 'sib-001',
      code: 1,
      canceling: false,
      actor: 'the parent',
      reason: 'could not start the child process: EACCES',
      now,
    });
    assert.equal(
      readStatus(spool, 'sib-001')?.error,
      'could not start the child process: EACCES'
    );
  });
});

for (const status of ['done', 'failed'] as const) {
  test(`a child that reported ${status} is left alone`, () => {
    withSpool(spool => {
      const reported = {
        status,
        branch: 'e/pi/fix-the-parser-1',
        exitCode: status === 'done' ? 0 : 9,
        updatedAt: '2026-09-13T10:04:00.000Z',
      };
      writeStatus(spool, 'sib-001', reported);
      settleChildRun({
        spoolDir: spool,
        id: 'sib-001',
        code: 0,
        canceling: false,
        actor: 'the parent',
        now,
      });
      assert.deepEqual(readStatus(spool, 'sib-001'), reported);
    });
  });
}

test('the actor names who cancelled', () => {
  withSpool(spool => {
    settleChildRun({
      spoolDir: spool,
      id: 'sib-001',
      code: 1,
      canceling: true,
      actor: 'the A2A client',
      now,
    });
    assert.equal(
      readStatus(spool, 'sib-001')?.error,
      'canceled by the A2A client'
    );
  });
});

test('logTail is empty for a child that never wrote anything', () => {
  withSpool(spool => {
    assert.equal(logTail(childLogFile(spool, 'sib-001')), '');
    fs.writeFileSync(childLogFile(spool, 'sib-001'), '');
    assert.equal(logTail(childLogFile(spool, 'sib-001')), '');
  });
});
