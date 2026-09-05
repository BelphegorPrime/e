import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createServeApp,
  detachedServeArguments,
  isServeStateLive,
  shouldReuseDetachedServe,
  startServeServer,
  type ServeAppDeps,
  type ServeState,
} from './serve';
import type { Git, RunCommit, RunRef } from './git/index';
import type { ModelsResponse } from './modelStatus';

test('detachedServeArguments preserves command arguments and removes detached flags', () => {
  assert.deepEqual(
    detachedServeArguments([
      '/usr/bin/node',
      '/workspace/dist/index.js',
      'serve',
      '--detached',
      '--host',
      '0.0.0.0',
      '-d',
      '--port',
      '8080',
    ]),
    ['/workspace/dist/index.js', 'serve', '--host', '0.0.0.0', '--port', '8080']
  );
});

test('serve app exposes API routes and the UI fallback', async () => {
  const uiDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'e-ui-'));
  await fs.writeFile(
    path.join(uiDirectory, 'index.html'),
    '<!doctype html><title>e</title>'
  );

  const server = await startServeServer(
    createServeApp(uiDirectory),
    '127.0.0.1',
    0
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const info = await fetch(`${baseUrl}/api/info`);
    assert.equal(info.status, 200);
    assert.deepEqual(await info.json(), { name: 'e', version: '1.0.0' });

    const page = await fetch(`${baseUrl}/projects/current`);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), '<!doctype html><title>e</title>');

    const missingApi = await fetch(`${baseUrl}/api/missing`);
    assert.equal(missingApi.status, 404);
    assert.deepEqual(await missingApi.json(), { error: 'Not found' });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
    await fs.rm(uiDirectory, { recursive: true, force: true });
  }
});

test('serve app exposes llama.cpp model status via /api/omniroute/models', async () => {
  const uiDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'e-ui-'));
  await fs.writeFile(
    path.join(uiDirectory, 'index.html'),
    '<!doctype html><title>e</title>'
  );
  const models: ModelsResponse = {
    data: [
      {
        id: 'org/model-a',
        status: {
          value: 'downloading',
          progress: { url: { done: 500, total: 1000 } },
        },
      },
    ],
  };
  const server = await startServeServer(
    createServeApp(uiDirectory, {
      llamaBaseUrl: 'http://llama-fake',
      fetchImpl: (async (input: string | URL | Request) => {
        assert.equal(String(input), 'http://llama-fake/models');
        return {
          ok: true,
          status: 200,
          json: async () => models,
        } as unknown as Response;
      }) as typeof fetch,
    }),
    '127.0.0.1',
    0
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const res = await fetch(`${baseUrl}/api/omniroute/models`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), models);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
    await fs.rm(uiDirectory, { recursive: true, force: true });
  }
});

test('serve app reports 503 when the llama.cpp stack is unreachable', async () => {
  const uiDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'e-ui-'));
  await fs.writeFile(
    path.join(uiDirectory, 'index.html'),
    '<!doctype html><title>e</title>'
  );
  const server = await startServeServer(
    createServeApp(uiDirectory, {
      llamaBaseUrl: 'http://llama-fake',
      fetchImpl: (async () => {
        throw new Error('connection refused');
      }) as typeof fetch,
    }),
    '127.0.0.1',
    0
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const res = await fetch(`${baseUrl}/api/omniroute/models`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), {
      error: 'llama.cpp stack is not running',
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
    await fs.rm(uiDirectory, { recursive: true, force: true });
  }
});

test('serve app reports 502 when llama.cpp answers with a non-OK status', async () => {
  const uiDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'e-ui-'));
  await fs.writeFile(
    path.join(uiDirectory, 'index.html'),
    '<!doctype html><title>e</title>'
  );
  const server = await startServeServer(
    createServeApp(uiDirectory, {
      llamaBaseUrl: 'http://llama-fake',
      fetchImpl: (async () =>
        ({ ok: false, status: 500 }) as unknown as Response) as typeof fetch,
    }),
    '127.0.0.1',
    0
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const res = await fetch(`${baseUrl}/api/omniroute/models`);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), {
      error: 'llama.cpp returned HTTP 500',
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
    await fs.rm(uiDirectory, { recursive: true, force: true });
  }
});

test('isServeStateLive: a dead pid makes the entry stale', async () => {
  const stale: ServeState = { pid: 999_999, host: '127.0.0.1', port: 8080 };
  const result = await isServeStateLive(stale, {
    isAlive: () => false,
    probeHealth: async () => {
      throw new Error('probe must not run when the pid is dead');
    },
  });
  assert.equal(result, false);
});

test('isServeStateLive: a live pid but unresponsive health check is stale in effect', async () => {
  const state: ServeState = { pid: 1234, host: '127.0.0.1', port: 8080 };
  let probedUrl = '';
  const result = await isServeStateLive(state, {
    isAlive: () => true,
    probeHealth: async url => {
      probedUrl = url;
      return false;
    },
  });
  assert.equal(result, false);
  assert.equal(probedUrl, 'http://127.0.0.1:8080/api/health');
});

test('isServeStateLive: live pid and answering health check mean serving', async () => {
  const state: ServeState = { pid: 1234, host: '127.0.0.1', port: 8080 };
  const result = await isServeStateLive(state, {
    isAlive: () => true,
    probeHealth: async () => true,
  });
  assert.equal(result, true);
});

test('shouldReuseDetachedServe: no recorded entry falls through to a fresh start', async () => {
  const result = await shouldReuseDetachedServe(undefined);
  assert.equal(result, false);
});

test('shouldReuseDetachedServe: a stale entry falls through to a fresh start', async () => {
  const stale: ServeState = { pid: 999_999, host: '127.0.0.1', port: 8080 };
  const result = await shouldReuseDetachedServe(stale, {
    isAlive: () => false,
  });
  assert.equal(result, false);
});

test('shouldReuseDetachedServe: a live entry short-circuits to already serving', async () => {
  const state: ServeState = { pid: 1234, host: '127.0.0.1', port: 8080 };
  const result = await shouldReuseDetachedServe(state, {
    isAlive: () => true,
    probeHealth: async () => true,
  });
  assert.equal(result, true);
});

/** Scripted `Git` fake for the branch-backed runs index routes. */
class FakeGit implements Git {
  refs: RunRef[];
  commits: Record<string, RunCommit[]> = {};
  throwsOn?: string;

  constructor(
    opts: {
      refs?: RunRef[];
      commits?: Record<string, RunCommit[]>;
      throwsOn?: string;
    } = {}
  ) {
    this.refs = opts.refs ?? [];
    this.commits = opts.commits ?? {};
    this.throwsOn = opts.throwsOn;
  }

  isRepo(): boolean {
    return true;
  }
  headSha(): string {
    return 'base';
  }
  listRunBranches(): string[] {
    return this.refs.map(ref => ref.name);
  }
  listRunRefs(): RunRef[] {
    if (this.throwsOn) throw new Error(this.throwsOn);
    return this.refs;
  }
  runLog(branch: string): RunCommit[] {
    return this.commits[branch] ?? [];
  }
  branchExists(branch: string): boolean {
    return this.refs.some(ref => ref.name === branch);
  }
  addWorktree(): void {}
  isDirty(): boolean {
    return false;
  }
  commitAll(): void {}
  hasCommitsBeyondBase(): boolean {
    return false;
  }
  push(): void {}
  removeWorktree(): void {}
}

/** Boots the app on an ephemeral port with a temp UI dir and runs `fn`. */
async function withServeApp(
  deps: ServeAppDeps,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const uiDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'e-ui-'));
  await fs.writeFile(
    path.join(uiDirectory, 'index.html'),
    '<!doctype html><title>e</title>'
  );
  const server = await startServeServer(
    createServeApp(uiDirectory, deps),
    '127.0.0.1',
    0
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
    await fs.rm(uiDirectory, { recursive: true, force: true });
  }
}

const runRefs: RunRef[] = [
  {
    name: 'e/claudeCode/fix-typos-2',
    sha: 'aaa',
    committerDate: '2025-01-02T10:00:00+00:00',
    subject: 'e: capture run output for e/claudeCode/fix-typos-2',
  },
  {
    name: 'origin/e/claudeCode/fix-typos-2',
    sha: 'aaa',
    committerDate: '2025-01-02T10:00:00+00:00',
    subject: 'e: capture run output for e/claudeCode/fix-typos-2',
  },
  {
    name: 'e/claudeCode/fix-typos-1',
    sha: 'bbb',
    committerDate: '2025-01-01T09:00:00+00:00',
    subject: 'older run',
  },
];

const runCommits: Record<string, RunCommit[]> = {
  'e/claudeCode/fix-typos-2': [
    {
      sha: 'aaa',
      subject: 'e: capture run output for e/claudeCode/fix-typos-2',
      committerDate: '2025-01-02T10:00:00+00:00',
    },
    {
      sha: 'base',
      subject: 'base commit',
      committerDate: '2025-01-01T09:00:00+00:00',
    },
  ],
};

test('/api/runs lists the branch-backed runs index, newest first', async () => {
  await withServeApp({ git: new FakeGit({ refs: runRefs }) }, async baseUrl => {
    const res = await fetch(`${baseUrl}/api/runs`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      runs: Array<{
        branch: string;
        agent: string;
        counter: number;
        pushed: boolean;
      }>;
    };
    assert.deepEqual(
      body.runs.map(run => [run.branch, run.agent, run.counter, run.pushed]),
      [
        ['e/claudeCode/fix-typos-2', 'claudeCode', 2, true],
        ['e/claudeCode/fix-typos-1', 'claudeCode', 1, false],
      ]
    );
  });
});

test('/api/runs: a local-only run reports local and unpushed', async () => {
  await withServeApp(
    {
      git: new FakeGit({ refs: [runRefs[2]!] }), // local twin only
    },
    async baseUrl => {
      const res = await fetch(`${baseUrl}/api/runs`);
      const body = (await res.json()) as {
        runs: Array<Record<string, unknown>>;
      };
      assert.deepEqual(body.runs, [
        {
          branch: 'e/claudeCode/fix-typos-1',
          agent: 'claudeCode',
          slug: 'fix-typos',
          counter: 1,
          sha: 'bbb',
          committerDate: '2025-01-01T09:00:00+00:00',
          subject: 'older run',
          local: true,
          pushed: false,
        },
      ]);
    }
  );
});

test('/api/runs/<branch> reports per-run status', async () => {
  await withServeApp(
    { git: new FakeGit({ refs: runRefs, commits: runCommits }) },
    async baseUrl => {
      const res = await fetch(`${baseUrl}/api/runs/e/claudeCode/fix-typos-2`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.deepEqual(body, {
        branch: 'e/claudeCode/fix-typos-2',
        agent: 'claudeCode',
        slug: 'fix-typos',
        counter: 2,
        commits: 2,
        latest: runCommits['e/claudeCode/fix-typos-2']![0],
        local: true,
        pushed: true,
      });
    }
  );
});

test('/api/runs/<branch>/logs returns the branch commit history', async () => {
  await withServeApp(
    { git: new FakeGit({ refs: runRefs, commits: runCommits }) },
    async baseUrl => {
      const res = await fetch(
        `${baseUrl}/api/runs/e/claudeCode/fix-typos-2/logs`
      );
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        branch: 'e/claudeCode/fix-typos-2',
        commits: runCommits['e/claudeCode/fix-typos-2'],
      });
    }
  );
});

test('/api/runs reads a remote-only run from its remote-tracking ref', async () => {
  const remoteOnly: RunRef = {
    name: 'origin/e/cheap-codex/tidy-tests-1',
    sha: 'ccc',
    committerDate: '2025-01-03T08:00:00+00:00',
    subject: 'remote-only run',
  };
  const commits: Record<string, RunCommit[]> = {
    'origin/e/cheap-codex/tidy-tests-1': [
      {
        sha: 'ccc',
        subject: 'remote-only run',
        committerDate: '2025-01-03T08:00:00+00:00',
      },
    ],
  };
  await withServeApp(
    { git: new FakeGit({ refs: [remoteOnly], commits }) },
    async baseUrl => {
      const status = await fetch(
        `${baseUrl}/api/runs/e/cheap-codex/tidy-tests-1`
      );
      assert.equal(status.status, 200);
      const body = (await status.json()) as {
        branch: string;
        local: boolean;
        pushed: boolean;
        commits: number;
      };
      assert.deepEqual(
        {
          branch: body.branch,
          local: body.local,
          pushed: body.pushed,
          commits: body.commits,
        },
        {
          branch: 'e/cheap-codex/tidy-tests-1',
          local: false,
          pushed: true,
          commits: 1,
        }
      );

      const logs = await fetch(
        `${baseUrl}/api/runs/e/cheap-codex/tidy-tests-1/logs`
      );
      assert.equal(logs.status, 200);
      assert.deepEqual(await logs.json(), {
        branch: 'e/cheap-codex/tidy-tests-1',
        commits: commits['origin/e/cheap-codex/tidy-tests-1'],
      });
    }
  );
});

test('/api/runs returns 404 for an unknown or non-run branch', async () => {
  await withServeApp(
    { git: new FakeGit({ refs: runRefs, commits: runCommits }) },
    async baseUrl => {
      for (const route of [
        '/api/runs/e/claudeCode/never-ran-9',
        '/api/runs/main',
        '/api/runs/not-a-run',
        '/api/runs/e/README',
      ]) {
        const res = await fetch(`${baseUrl}${route}`);
        assert.equal(res.status, 404, `route ${route}`);
        assert.deepEqual(await res.json(), { error: 'Not found' });
      }
    }
  );
});

test('/api/runs reports 500 when git enumeration fails', async () => {
  await withServeApp(
    { git: new FakeGit({ refs: runRefs, throwsOn: 'not a repository' }) },
    async baseUrl => {
      const res = await fetch(`${baseUrl}/api/runs`);
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), {
        error: 'not a repository',
      });
    }
  );
});
