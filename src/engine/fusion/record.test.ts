import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CandidateResult } from '../../core/fusion/result.js';
import {
  candidateDirFor,
  fusionsDirFor,
  prepareCandidateDir,
  readCandidateResults,
  writeCandidateResult,
} from './record.js';

/*
 * The fusion record (ADR-0019 section 6): in the Store, never under the
 * worktrees dir; 0700/0600; git-ignored; and readable after the coordinator
 * that wrote it has died.
 */

const FUSION = 'fusion-01K6ZQ4W0R1X2Y3Z4A5B6C7D8E';

function withStore(fn: (storeDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-fusion-record-'));
  try {
    fn(path.join(root, '.e'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function result(candidate: string): CandidateResult {
  return {
    schemaVersion: 1,
    fusion: FUSION,
    candidate,
    agent: 'codex',
    harness: { name: 'codex', version: '0.159.0' },
    provider: null,
    skills: [],
    mcp: [],
    base: { sha: 'b', branch: 'main' },
    branch: null,
    tip: null,
    changes: { files: [], added: 0, removed: 0 },
    patch: null,
    patchTruncated: false,
    files: null,
    filesTruncated: false,
    outcome: 'failed',
    exitCode: 1,
    reason: null,
    attempt: 1,
    retryOf: null,
    startedAt: '2026-09-30T10:00:00.000Z',
    endedAt: '2026-09-30T10:00:01.000Z',
    elapsedMs: 1000,
    usage: null,
  };
}

test('prepareCandidateDir: private directories under .e/runs/fusions/, git-ignored', () => {
  withStore(storeDir => {
    const dir = prepareCandidateDir(storeDir, FUSION, 'cand-001');
    assert.equal(
      dir,
      path.join(storeDir, 'runs', 'fusions', FUSION, 'candidates', 'cand-001')
    );
    for (const d of [
      fusionsDirFor(storeDir),
      path.join(fusionsDirFor(storeDir), FUSION),
      path.join(fusionsDirFor(storeDir), FUSION, 'candidates'),
      dir,
    ]) {
      assert.equal(fs.statSync(d).mode & 0o777, 0o700, d);
    }
    // A partly committed Store never commits a prompt or a patch.
    const ignore = path.join(fusionsDirFor(storeDir), '.gitignore');
    assert.equal(fs.readFileSync(ignore, 'utf8'), '*\n');
    assert.equal(fs.statSync(ignore).mode & 0o777, 0o600);
  });
});

test('prepareCandidateDir: a leftover of a crashed collect starts over', () => {
  withStore(storeDir => {
    const dir = prepareCandidateDir(storeDir, FUSION, 'cand-001');
    fs.writeFileSync(path.join(dir, 'patch.diff'), 'half');
    prepareCandidateDir(storeDir, FUSION, 'cand-001');
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('prepareCandidateDir: a finished attempt is never collected over', () => {
  withStore(storeDir => {
    const dir = prepareCandidateDir(storeDir, FUSION, 'cand-001');
    writeCandidateResult(dir, result('cand-001'));
    assert.throws(
      () => prepareCandidateDir(storeDir, FUSION, 'cand-001'),
      /cand-001 of fusion-.* is already collected; a candidate id is never reused/
    );
    assert.equal(
      readCandidateResults(storeDir, FUSION)[0].result?.candidate,
      'cand-001'
    );
  });
});

test('readCandidateResults: an envelope filed under another id is not read as that id', () => {
  withStore(storeDir => {
    const dir = prepareCandidateDir(storeDir, FUSION, 'cand-002');
    fs.writeFileSync(
      path.join(dir, 'result.json'),
      JSON.stringify(result('cand-001'))
    );
    const [loaded] = readCandidateResults(storeDir, FUSION);
    assert.equal(loaded.result, undefined);
    assert.match(
      loaded.error ?? '',
      /is fusion-.*\/cand-001, not fusion-.*\/cand-002/
    );
  });
});

test('candidateDirFor: ids that are not ids never become a path', () => {
  assert.throws(
    () => candidateDirFor('/s/.e', '../../etc', 'cand-001'),
    /not a fusion id/
  );
  assert.throws(
    () => candidateDirFor('/s/.e', FUSION, '../cand-001'),
    /not a candidate id/
  );
});

test('writeCandidateResult: 0600, written whole or not at all, and read back', () => {
  withStore(storeDir => {
    const dir = prepareCandidateDir(storeDir, FUSION, 'cand-001');
    writeCandidateResult(dir, result('cand-001'));
    const file = path.join(dir, 'result.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(
      fs.readdirSync(dir),
      ['result.json'],
      'no temp file left behind'
    );
    assert.deepEqual(readCandidateResults(storeDir, FUSION), [
      { candidate: 'cand-001', result: result('cand-001') },
    ]);
  });
});

test('writeCandidateResult: refuses an envelope its own reader would refuse', () => {
  withStore(storeDir => {
    const dir = prepareCandidateDir(storeDir, FUSION, 'cand-001');
    assert.throws(
      () =>
        writeCandidateResult(dir, {
          ...result('cand-001'),
          outcome: 'great' as CandidateResult['outcome'],
        }),
      /unknown outcome/
    );
    assert.equal(fs.existsSync(path.join(dir, 'result.json')), false);
  });
});

test('readCandidateResults: survives the coordinator, and says what a crash left', () => {
  withStore(storeDir => {
    assert.deepEqual(readCandidateResults(storeDir, FUSION), []);
    for (const id of ['cand-002', 'cand-001', 'cand-003']) {
      const dir = prepareCandidateDir(storeDir, FUSION, id);
      if (id !== 'cand-003') writeCandidateResult(dir, result(id));
    }
    // cand-003's collect died before its envelope; cand-004 is from a newer e.
    const newer = prepareCandidateDir(storeDir, FUSION, 'cand-004');
    fs.writeFileSync(
      path.join(newer, 'result.json'),
      JSON.stringify({ ...result('cand-004'), schemaVersion: 2 })
    );
    fs.mkdirSync(
      path.join(fusionsDirFor(storeDir), FUSION, 'candidates', 'junk')
    );
    const loaded = readCandidateResults(storeDir, FUSION);
    assert.deepEqual(
      loaded.map(entry => entry.candidate),
      ['cand-001', 'cand-002', 'cand-003', 'cand-004']
    );
    assert.equal(loaded[0].result?.candidate, 'cand-001');
    assert.equal(loaded[2].result, undefined);
    assert.match(loaded[2].error ?? '', /incomplete: no result\.json/);
    assert.match(loaded[3].error ?? '', /schemaVersion 2 is not 1/);
  });
});
