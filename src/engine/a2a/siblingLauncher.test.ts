import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { productionSiblingLauncher } from './siblingLauncher.js';
import {
  ensureSpool,
  readStatus,
} from '../../sidecars/broker/contract/spool.js';
import { childLogFile } from '../runs/childRun.js';
import type { SpawnRequest } from '../../sidecars/broker/contract/types.js';

/** A Store with one remote agent and one harness agent. */
function withStore(fn: (root: string, spool: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-launcher-'));
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), 'e-launcher-spool-'));
  const agents = path.join(root, '.e', 'agents');
  fs.mkdirSync(path.join(agents, 'remote-researcher'), { recursive: true });
  fs.writeFileSync(
    path.join(agents, 'remote-researcher', 'agent.json'),
    JSON.stringify({
      name: 'remote-researcher',
      transport: 'a2a',
      url: 'http://127.0.0.1:1/a2a',
    })
  );
  ensureSpool(spool);
  return fn(root, spool).finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(spool, { recursive: true, force: true });
  });
}

const request = (agent: string): SpawnRequest => ({
  id: 'sib-001',
  agent,
  prompt: 'look into X',
  requestedAt: 't',
});

test('a remote agent is answered in-process: no child is spawned', async () => {
  await withStore(async (root, spool) => {
    const launch = productionSiblingLauncher(root, {});
    const handle = launch({
      request: request('remote-researcher'),
      args: ['spawn', 'remote-researcher'],
      env: {},
      logFile: childLogFile(spool, 'sib-001'),
      spoolDir: spool,
    });
    // The endpoint refuses (port 1), so it fails - but through the A2A path,
    // which reports into the spool rather than writing a process log.
    assert.equal(await handle.exited, 1);
    assert.match(readStatus(spool, 'sib-001')?.error ?? '', /remote agent/);
    assert.equal(
      fs.existsSync(childLogFile(spool, 'sib-001')),
      false,
      'a child process log would mean a process was spawned'
    );
  });
});

test('an unknown agent falls through to the child process', () => {
  return withStore(async (root, spool) => {
    const launch = productionSiblingLauncher(root, {});
    // The fork-bomb guard is the discriminator here: only the child-process
    // branch re-invokes this CLI, and it refuses because the test runner is
    // not `index.js`. The A2A branch never calls `selfInvocation` at all, so
    // this throw *is* the proof that an unknown agent took the process path -
    // which is what lets one place report "no such agent" instead of two.
    assert.throws(
      () =>
        launch({
          request: request('no-such-agent'),
          args: ['--version'],
          env: {},
          logFile: childLogFile(spool, 'sib-001'),
          spoolDir: spool,
        }),
      /Refusing to re-invoke .* as the e CLI/
    );
    assert.equal(
      readStatus(spool, 'sib-001'),
      undefined,
      'the A2A path would have written a status; the process path does not'
    );
  });
});

test('a harness agent in the Store also takes the child-process path', () => {
  return withStore(async (root, spool) => {
    const agents = path.join(root, '.e', 'agents', 'local-pi');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(
      path.join(agents, 'agent.json'),
      JSON.stringify({ name: 'local-pi', harness: 'pi' })
    );
    const launch = productionSiblingLauncher(root, {});
    assert.throws(
      () =>
        launch({
          request: request('local-pi'),
          args: ['--version'],
          env: {},
          logFile: childLogFile(spool, 'sib-001'),
          spoolDir: spool,
        }),
      /Refusing to re-invoke .* as the e CLI/
    );
  });
});
