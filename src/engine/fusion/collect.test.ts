import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryGit } from '../../ports/git/memory.js';
import { secretRedactor } from '../../core/fusion/redact.js';
import {
  collectCandidateResult,
  withoutBinaryHunks,
  type SettledCandidate,
} from './collect.js';
import { readCandidateResults } from './record.js';

/*
 * Collecting a settled candidate (ADR-0019 section 5): the envelope is built
 * from the spool's facts and host-side git only, never from anything the
 * candidate wrote about itself, and it is written last, so an envelope on
 * disk means its patch and files are complete.
 */

const FUSION = 'fusion-01K6ZQ4W0R1X2Y3Z4A5B6C7D8E';
const BRANCH = 'e/codex/add-retry-4';

function withStore(fn: (storeDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-fusion-collect-'));
  try {
    fn(path.join(root, '.e'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function settled(over: Partial<SettledCandidate> = {}): SettledCandidate {
  return {
    fusion: FUSION,
    candidate: 'cand-002',
    agent: {
      name: 'codex',
      harness: 'codex',
      provider: {
        baseUrl: 'http://gateway.internal/v1',
        model: 'gpt-5.3-codex',
        protocol: 'openai-responses',
        apiKeyEnv: 'OPENAI_API_KEY',
      },
      skills: ['web-search'],
    },
    harnessVersion: '0.159.0',
    mcp: ['files'],
    base: { sha: 'base0000', branch: 'main' },
    branch: BRANCH,
    exitCode: 0,
    attempt: 1,
    startedAt: new Date('2026-09-30T10:00:00.000Z'),
    endedAt: new Date('2026-09-30T10:21:40.000Z'),
    ...over,
  };
}

function gitWithWork(over: ConstructorParameters<typeof InMemoryGit>[0] = {}) {
  return new InMemoryGit({
    refCommits: { [`refs/heads/${BRANCH}`]: 'tip00000' },
    numstat: [
      { path: 'src/retry.ts', added: 41, removed: 3 },
      { path: 'logo.png', added: null, removed: null },
      { path: 'src/gone.ts', added: 0, removed: 7 },
    ],
    diff: 'diff --git a/src/retry.ts b/src/retry.ts\n+x\n',
    files: {
      tip00000: { 'src/retry.ts': 'export {}\n', 'logo.png': 'PNG' },
    },
    ...over,
  });
}

test('collectCandidateResult: a candidate with work - its changes, patch and files, neutral identities', () => {
  withStore(storeDir => {
    const git = gitWithWork();
    const result = collectCandidateResult(git, storeDir, settled());
    const dir = path.join(
      storeDir,
      'runs',
      'fusions',
      FUSION,
      'candidates',
      'cand-002'
    );

    assert.deepEqual(result, {
      schemaVersion: 1,
      fusion: FUSION,
      candidate: 'cand-002',
      agent: 'codex',
      harness: { name: 'codex', version: '0.159.0' },
      // What the Agent declared, and nothing a key or an endpoint could leak.
      provider: { protocol: 'openai-responses', model: 'gpt-5.3-codex' },
      skills: ['web-search'],
      mcp: ['files'],
      base: { sha: 'base0000', branch: 'main' },
      branch: BRANCH,
      tip: 'tip00000',
      changes: {
        files: [
          { path: 'src/retry.ts', added: 41, removed: 3 },
          { path: 'logo.png', added: null, removed: null },
          { path: 'src/gone.ts', added: 0, removed: 7 },
        ],
        added: 41,
        removed: 10,
      },
      patch: 'patch.diff',
      patchTruncated: false,
      files: 'files',
      filesTruncated: false,
      outcome: 'succeeded',
      exitCode: 0,
      reason: null,
      attempt: 1,
      retryOf: null,
      startedAt: '2026-09-30T10:00:00.000Z',
      endedAt: '2026-09-30T10:21:40.000Z',
      elapsedMs: 1_300_000,
      usage: null,
    });
    // The whole repository, from the pinned base to the tip.
    assert.deepEqual(git.numstats, [
      { base: 'base0000', tip: 'tip00000', pathspecs: [':/'] },
    ]);
    assert.equal(git.diffs[0].base, 'base0000');
    assert.equal(
      fs.readFileSync(path.join(dir, 'patch.diff'), 'utf8'),
      'diff --git a/src/retry.ts b/src/retry.ts\n+x\n'
    );
    assert.equal(fs.statSync(path.join(dir, 'patch.diff')).mode & 0o777, 0o600);
    assert.equal(
      fs.readFileSync(path.join(dir, 'files', 'src', 'retry.ts'), 'utf8'),
      'export {}\n'
    );
    assert.equal(
      fs.existsSync(path.join(dir, 'files', 'src', 'gone.ts')),
      false
    );
    // And it is what the record reads back.
    assert.deepEqual(readCandidateResults(storeDir, FUSION), [
      { candidate: 'cand-002', result },
    ]);
  });
});

test('collectCandidateResult: an empty candidate - exit 0, nothing beyond the base - has no tip, patch or files', () => {
  withStore(storeDir => {
    const git = gitWithWork({ hasCommitsBeyondBase: false });
    const result = collectCandidateResult(git, storeDir, settled());
    assert.equal(result.outcome, 'empty');
    assert.equal(result.tip, null);
    assert.equal(result.patch, null);
    assert.equal(result.files, null);
    assert.deepEqual(result.changes, { files: [], added: 0, removed: 0 });
    assert.equal(git.calls.includes('diff'), false);
  });
});

test('collectCandidateResult: a failed candidate keeps its commits, and so stays usable', () => {
  withStore(storeDir => {
    const result = collectCandidateResult(
      gitWithWork(),
      storeDir,
      settled({
        exitCode: 2,
        reason: 'exhausted:iterations',
        verify: { verdict: 'red', attempts: 3 },
      })
    );
    assert.equal(result.outcome, 'failed');
    assert.equal(result.tip, 'tip00000');
    assert.equal(result.reason, 'exhausted:iterations');
    assert.deepEqual(result.verify, { verdict: 'red', attempts: 3 });
  });
});

test('collectCandidateResult: a candidate that died before its branch existed', () => {
  withStore(storeDir => {
    const git = gitWithWork();
    const result = collectCandidateResult(
      git,
      storeDir,
      settled({
        branch: undefined,
        exitCode: undefined,
        reason: 'aborted:harness-exit',
      })
    );
    assert.equal(result.outcome, 'failed');
    assert.equal(result.branch, null);
    assert.equal(result.tip, null);
    assert.equal(result.exitCode, null);
    assert.equal(git.calls.includes('hasCommitsBeyondBase'), false);
  });
});

test('collectCandidateResult: the fusion deadline outranks the exit code', () => {
  withStore(storeDir => {
    const result = collectCandidateResult(
      gitWithWork(),
      storeDir,
      settled({ exitCode: 143, stoppedBy: 'candidates-deadline' })
    );
    assert.equal(result.outcome, 'timed-out');
    // Earlier attempts' commits stay: a timed-out candidate can still be usable.
    assert.equal(result.tip, 'tip00000');
  });
});

test('collectCandidateResult: the budgets cut the patch and the files, and the envelope says so', () => {
  withStore(storeDir => {
    const git = gitWithWork({ diff: 'line one\nline two\n' });
    const result = collectCandidateResult(git, storeDir, settled(), {
      patchMaxBytes: 12,
      filesMaxBytes: 5,
    });
    assert.equal(result.patchTruncated, true);
    assert.equal(result.filesTruncated, true);
    const dir = path.join(
      storeDir,
      'runs',
      'fusions',
      FUSION,
      'candidates',
      'cand-002'
    );
    assert.equal(
      fs.readFileSync(path.join(dir, 'patch.diff'), 'utf8'),
      'line one\n'
    );
    // retry.ts (10 bytes) does not fit, logo.png (3) does.
    assert.equal(fs.existsSync(path.join(dir, 'files', 'logo.png')), true);
    assert.equal(
      fs.existsSync(path.join(dir, 'files', 'src', 'retry.ts')),
      false
    );
  });
});

test('collectCandidateResult: an Agent without a provider, a retry, reported usage and the image', () => {
  withStore(storeDir => {
    const result = collectCandidateResult(
      gitWithWork(),
      storeDir,
      settled({
        candidate: 'cand-004',
        agent: { name: 'pi', harness: 'pi' },
        harnessVersion: '0.99.0',
        image: 'e-agent-pi',
        attempt: 2,
        retryOf: 'cand-001',
        usage: { outputTokens: 900 },
      })
    );
    assert.equal(result.provider, null);
    assert.deepEqual(result.skills, []);
    assert.deepEqual(result.harness, {
      name: 'pi',
      version: '0.99.0',
      image: 'e-agent-pi',
    });
    assert.equal(result.attempt, 2);
    assert.equal(result.retryOf, 'cand-001');
    assert.deepEqual(result.usage, { outputTokens: 900 });
  });
});

test('collectCandidateResult: known secrets are out of the patch and the files before they are kept', () => {
  withStore(storeDir => {
    const key = 'sk-live-0123456789';
    const git = gitWithWork({
      diff: `diff --git a/.env b/.env\n+OPENAI_API_KEY=${key}\n`,
      files: {
        tip00000: {
          'src/retry.ts': `const key = '${key}';\n`,
          'logo.png': 'PNG',
        },
      },
    });
    collectCandidateResult(git, storeDir, settled(), {
      redact: secretRedactor({ OPENAI_API_KEY: key }),
    });
    const dir = path.join(
      storeDir,
      'runs',
      'fusions',
      FUSION,
      'candidates',
      'cand-002'
    );
    const patch = fs.readFileSync(path.join(dir, 'patch.diff'), 'utf8');
    assert.equal(patch.includes(key), false);
    assert.match(patch, /\[redacted:OPENAI_API_KEY\]/);
    assert.equal(
      fs.readFileSync(path.join(dir, 'files', 'src', 'retry.ts'), 'utf8'),
      "const key = '[redacted:OPENAI_API_KEY]';\n"
    );
    assert.equal(
      fs.readFileSync(path.join(dir, 'files', 'logo.png'), 'utf8'),
      'PNG'
    );
  });
});

test('withoutBinaryHunks: a binary payload, where base85 would hide a secret, becomes a note', () => {
  const patch = [
    'diff --git a/a.txt b/a.txt',
    '+text',
    'diff --git a/blob.bin b/blob.bin',
    'GIT binary patch',
    'literal 12',
    'zcmZ?wbhEHbRA2xA',
    '',
    'literal 0',
    'HcmV?d00001',
    '',
    'diff --git a/b.txt b/b.txt',
    '+more',
    '',
  ].join('\n');
  assert.equal(
    withoutBinaryHunks(Buffer.from(patch)).toString(),
    [
      'diff --git a/a.txt b/a.txt',
      '+text',
      'diff --git a/blob.bin b/blob.bin',
      'Binary content omitted: the file is in files/, redacted.',
      'diff --git a/b.txt b/b.txt',
      '+more',
      '',
    ].join('\n')
  );
  const plain = Buffer.from('diff --git a/x b/x\n+x\n');
  assert.equal(withoutBinaryHunks(plain), plain);
});
