import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fromBranch, type RunName } from '../../core/identity/runName.js';
import {
  SESSION_RETENTION_MS,
  addSessionElapsed,
  hasSessionTranscript,
  openRunSession,
  pruneRunSessions,
  readRunSession,
  runSessionDirFor,
  sessionsDirFor,
  type RunSessionInit,
} from './runSession.js';

const run = fromBranch('e/pi/fix-the-bug-2') as RunName;
const init: RunSessionInit = {
  agent: 'pi',
  harness: 'pi',
  harnessVersion: '0.99.0',
  mcp: ['everything'],
  skills: ['lint'],
};
const base = { sha: 'basesha', branch: 'main' };
const now = new Date('2026-09-30T10:00:00.000Z');

function withStoreDir<T>(fn: (storeDir: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-run-session-'));
  try {
    return fn(path.join(root, '.e'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

test('a session lives under .e/runs/sessions/<run name>, beside the queue spools', () => {
  assert.equal(
    runSessionDirFor('/repo/.e', run),
    path.join('/repo/.e', 'runs', 'sessions', 'e-pi-fix-the-bug-2')
  );
  assert.equal(sessionsDirFor('/repo/.e'), '/repo/.e/runs/sessions');
});

test('openRunSession creates the dirs 0700, the record 0600, and a .gitignore that ignores it all', () => {
  withStoreDir(storeDir => {
    const session = openRunSession(storeDir, run, { init, base }, now);
    assert.equal(session.dir, runSessionDirFor(storeDir, run));
    assert.equal(session.transcriptDir, path.join(session.dir, 'harness'));
    assert.equal(mode(sessionsDirFor(storeDir)), 0o700);
    assert.equal(mode(session.dir), 0o700);
    assert.equal(mode(session.transcriptDir), 0o700);
    assert.equal(mode(path.join(session.dir, 'session.json')), 0o600);
    assert.equal(
      fs.readFileSync(
        path.join(sessionsDirFor(storeDir), '.gitignore'),
        'utf8'
      ),
      '*\n'
    );
    assert.deepEqual(readRunSession(storeDir, run), {
      ...init,
      branch: run.branch,
      base,
      elapsedMs: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  });
});

test('reopening a session keeps its base, creation time and wall clock, and takes the current agent', () => {
  withStoreDir(storeDir => {
    openRunSession(storeDir, run, { init, base }, now);
    addSessionElapsed(storeDir, run, 1500, now);
    const later = new Date('2026-10-01T10:00:00.000Z');
    const reopened = openRunSession(
      storeDir,
      run,
      {
        init: { ...init, harnessVersion: '1.0.0' },
        base: { sha: 'other', branch: 'dev' },
      },
      later
    );
    assert.deepEqual(reopened.record, {
      ...init,
      harnessVersion: '1.0.0',
      branch: run.branch,
      base,
      elapsedMs: 1500,
      createdAt: now.toISOString(),
      updatedAt: later.toISOString(),
    });
  });
});

test('addSessionElapsed accumulates across invocations; with no record it does nothing', () => {
  withStoreDir(storeDir => {
    addSessionElapsed(storeDir, run, 10, now);
    assert.equal(readRunSession(storeDir, run), undefined);
    openRunSession(storeDir, run, { init, base }, now);
    addSessionElapsed(storeDir, run, 10, now);
    addSessionElapsed(storeDir, run, 32, now);
    assert.equal(readRunSession(storeDir, run)?.elapsedMs, 42);
  });
});

test('a record that is not one reads as absent', () => {
  withStoreDir(storeDir => {
    const session = openRunSession(storeDir, run, { init, base }, now);
    fs.writeFileSync(path.join(session.dir, 'session.json'), '{"branch":1}');
    assert.equal(readRunSession(storeDir, run), undefined);
    fs.writeFileSync(path.join(session.dir, 'session.json'), 'not json');
    assert.equal(readRunSession(storeDir, run), undefined);
  });
});

test('hasSessionTranscript is true once the harness wrote any file, at any depth', () => {
  withStoreDir(storeDir => {
    assert.equal(hasSessionTranscript(storeDir, run), false);
    const session = openRunSession(storeDir, run, { init, base }, now);
    assert.equal(hasSessionTranscript(storeDir, run), false);
    // pi groups by working directory: sessions/--workspace--/<id>.jsonl
    const grouped = path.join(session.transcriptDir, '--workspace--');
    fs.mkdirSync(grouped);
    assert.equal(hasSessionTranscript(storeDir, run), false);
    fs.writeFileSync(path.join(grouped, 'a.jsonl'), '{}\n');
    assert.equal(hasSessionTranscript(storeDir, run), true);
  });
});

test('pruneRunSessions deletes sessions untouched past the retention, and nothing else', () => {
  withStoreDir(storeDir => {
    const old = fromBranch('e/pi/old-1') as RunName;
    const fresh = fromBranch('e/pi/fresh-1') as RunName;
    const stray = path.join(sessionsDirFor(storeDir), 'e-pi-stray-1');
    openRunSession(storeDir, old, { init, base }, now);
    const later = new Date(now.getTime() + SESSION_RETENTION_MS + 1);
    openRunSession(storeDir, fresh, { init, base }, later);
    // A directory with no readable record is judged by its mtime.
    fs.mkdirSync(stray);
    fs.utimesSync(stray, later, later);
    const removed = pruneRunSessions(storeDir, later);
    assert.deepEqual(removed, ['e-pi-old-1']);
    assert.equal(readRunSession(storeDir, old), undefined);
    assert.ok(readRunSession(storeDir, fresh));
    assert.ok(fs.existsSync(stray));
    // The .gitignore is not a session.
    assert.ok(fs.existsSync(path.join(sessionsDirFor(storeDir), '.gitignore')));
    const muchLater = new Date(later.getTime() + SESSION_RETENTION_MS + 60_000);
    assert.deepEqual(pruneRunSessions(storeDir, muchLater).sort(), [
      'e-pi-fresh-1',
      'e-pi-stray-1',
    ]);
  });
});

test('pruneRunSessions of a Store with no sessions is a no-op', () => {
  withStoreDir(storeDir => {
    assert.deepEqual(pruneRunSessions(storeDir, now), []);
  });
});
