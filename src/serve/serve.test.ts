import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createServeApp,
  detachedServeArguments,
  isServeStateLive,
  omniRouteEmbedPortFor,
  shouldReuseDetachedServe,
  startOmniRouteEmbedProxy,
  startServeServer,
  type ServeAppDeps,
  type ServeState,
} from './serve.js';
import type { Git, RunCommit, RunRef, MergeOutcome } from '../git/index.js';
import { TerminalSessions } from './terminalSessions.js';
import { fakeEngine, scriptedSpawner } from './terminalSessions.testSupport.js';
import { E_VERSION } from '../version.js';
import type { A2aAccess } from '../a2a/access.js';
import { A2aTasks } from '../a2a/tasks.js';
import { SseParser } from '../broker/events.js';
import {
  ensureSpool,
  writeRequest,
  writeRunInfo,
  writeStatus,
} from '../broker/spool.js';
import type { StatusResponse } from '../broker/types.js';
import { brokerSpoolDirFor } from '../runs/runBroker.js';

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

test('detachedServeArguments drops the snapshot entry path in a single-executable', () => {
  // In a pkg --sea binary argv[1] is the embedded entry, which the executable
  // runs by itself; passing it again would be taken for an unknown command.
  assert.deepEqual(
    detachedServeArguments(
      [
        '/usr/local/bin/e',
        '/snapshot/e/dist/index.js',
        'serve',
        '-d',
        '--port',
        '9000',
      ],
      true
    ),
    ['serve', '--port', '9000']
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
    assert.deepEqual(await info.json(), {
      name: 'e',
      version: E_VERSION,
      omniRouteEmbedPort: null,
      terminal: false,
    });

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

test('serve app proxies /api/egress/logs to the egress API without a double slash', async () => {
  const uiDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'e-ui-'));
  await fs.writeFile(
    path.join(uiDirectory, 'index.html'),
    '<!doctype html><title>e</title>'
  );
  const server = await startServeServer(
    createServeApp(uiDirectory, {
      egressApiUrl: 'http://egress-fake',
      fetchImpl: (async (input: string | URL | Request) => {
        assert.equal(String(input), 'http://egress-fake/logs');
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '[]',
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
    const res = await fetch(`${baseUrl}/api/egress/logs`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
    await fs.rm(uiDirectory, { recursive: true, force: true });
  }
});

test('serve app forwards the query string of a proxied /api/egress GET (the /logs filters live there)', async () => {
  const uiDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'e-ui-'));
  await fs.writeFile(path.join(uiDirectory, 'index.html'), '<!doctype html>');
  const seen: string[] = [];
  const server = await startServeServer(
    createServeApp(uiDirectory, {
      egressApiUrl: 'http://egress-fake',
      fetchImpl: (async (input: string | URL | Request) => {
        seen.push(String(input));
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '[]',
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
    const res = await fetch(
      `${baseUrl}/api/egress/logs?limit=10&action=deny(sinkholed)`
    );
    assert.equal(res.status, 200);
    assert.deepEqual(seen, [
      'http://egress-fake/logs?limit=10&action=deny(sinkholed)',
    ]);
    // A bare prefix (with or without a query) is not a proxied route.
    assert.equal((await fetch(`${baseUrl}/api/egress/?x=1`)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
    await fs.rm(uiDirectory, { recursive: true, force: true });
  }
});

test('serve app forwards the parsed JSON body on a proxied /api/egress POST', async () => {
  const uiDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'e-ui-'));
  await fs.writeFile(
    path.join(uiDirectory, 'index.html'),
    '<!doctype html><title>e</title>'
  );
  const server = await startServeServer(
    createServeApp(uiDirectory, {
      egressApiUrl: 'http://egress-fake',
      fetchImpl: (async (
        input: string | URL | Request,
        init?: Parameters<typeof fetch>[1]
      ) => {
        assert.equal(String(input), 'http://egress-fake/blacklist/domains');
        assert.equal(init?.body, JSON.stringify({ domain: 'golem.de' }));
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({ status: 'ok' }),
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
    const res = await fetch(`${baseUrl}/api/egress/blacklist/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'golem.de' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
    await fs.rm(uiDirectory, { recursive: true, force: true });
  }
});

test('OmniRoute embed proxy mirrors paths 1:1, strips framing headers and keeps session cookies scoped to its origin', async () => {
  const seen: { url?: string; body?: string } = {};
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      seen.url = req.url;
      seen.body = body;
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-security-policy': "frame-ancestors 'none'",
        'x-frame-options': 'DENY',
        'set-cookie':
          'auth_token=abc; Path=/; Domain=omniroute.local; Secure; HttpOnly',
      });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');
  const proxy = await startOmniRouteEmbedProxy(
    '127.0.0.1',
    0,
    `http://127.0.0.1:${upstreamAddress.port}`
  );
  const address = proxy.address();
  assert.ok(address && typeof address !== 'string');
  try {
    // OmniRoute's login endpoint is root-anchored, not under /dashboard.
    const res = await fetch(`http://127.0.0.1:${address.port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'pw' }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen.url, '/api/auth/login');
    assert.equal(seen.body, '{"password":"pw"}');
    assert.equal(res.headers.get('content-security-policy'), null);
    assert.equal(res.headers.get('x-frame-options'), null);
    assert.equal(
      res.headers.get('set-cookie'),
      'auth_token=abc; Path=/; HttpOnly'
    );
  } finally {
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test('serve app publishes the OmniRoute embed port via /api/info', async () => {
  const uiDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'e-ui-'));
  await fs.writeFile(path.join(uiDirectory, 'index.html'), '<!doctype html>');
  const server = await startServeServer(
    createServeApp(uiDirectory, { omniRouteEmbedPort: 8081 }),
    '127.0.0.1',
    0
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const info = await fetch(`http://127.0.0.1:${address.port}/api/info`);
    assert.deepEqual(await info.json(), {
      name: 'e',
      version: E_VERSION,
      omniRouteEmbedPort: 8081,
      terminal: false,
    });
    assert.equal(omniRouteEmbedPortFor(8080), 8081);
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
  currentBranch(): string {
    return 'main';
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
  merge(): MergeOutcome {
    return { status: 'merged' };
  }
  mergeInProgress(): boolean {
    return false;
  }
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

// --- browser terminal routes (ADR-0014) --------------------------------------

test('terminal routes answer 503 when no session manager is wired', async () => {
  const uiDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'e-ui-'));
  const server = await startServeServer(
    createServeApp(uiDirectory, { listAgents: () => [] }),
    '127.0.0.1',
    0
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const list = await fetch(`${baseUrl}/api/terminal/sessions`);
    assert.equal(list.status, 503);
    const start = await fetch(`${baseUrl}/api/terminal/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'pi' }),
    });
    assert.equal(start.status, 503);
  } finally {
    server.close();
  }
});

test('terminal routes list agents, start, inspect and remove sessions', async () => {
  const uiDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'e-ui-'));
  const spawner = scriptedSpawner();
  const terminal = new TerminalSessions({
    engine: fakeEngine({ containers: [] }),
    spawnChild: spawner.spawn,
    pollIntervalMs: 1000,
  });
  const server = await startServeServer(
    createServeApp(uiDirectory, {
      terminal,
      listAgents: () => [
        {
          name: 'slow-cc',
          harness: 'claude-code',
          model: null,
          default: false,
        },
        { name: 'smart-pi', harness: 'pi', model: 'auto', default: true },
      ],
    }),
    '127.0.0.1',
    0
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const info = await fetch(`${baseUrl}/api/info`);
    assert.equal(((await info.json()) as { terminal: boolean }).terminal, true);

    const agents = await fetch(`${baseUrl}/api/agents`);
    // The default-harness agent sorts first regardless of store order.
    assert.deepEqual(await agents.json(), {
      agents: [
        { name: 'smart-pi', harness: 'pi', model: 'auto', default: true },
        {
          name: 'slow-cc',
          harness: 'claude-code',
          model: null,
          default: false,
        },
      ],
    });

    const bad = await fetch(`${baseUrl}/api/terminal/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: '../x' }),
    });
    assert.equal(bad.status, 400);

    const start = await fetch(`${baseUrl}/api/terminal/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'smart-pi', name: 'fix-login' }),
    });
    assert.equal(start.status, 201);
    const { session } = (await start.json()) as {
      session: { id: string; agent: string; slug: string; phase: string };
    };
    assert.equal(session.agent, 'smart-pi');
    assert.equal(session.slug, 'fix-login');
    assert.equal(session.phase, 'starting');
    assert.deepEqual(spawner.calls[0], [
      'spawn',
      'smart-pi',
      '--name',
      'fix-login',
    ]);

    const list = await fetch(`${baseUrl}/api/terminal/sessions`);
    const listed = (await list.json()) as { sessions: Array<{ id: string }> };
    assert.deepEqual(
      listed.sessions.map(entry => entry.id),
      [session.id]
    );

    const one = await fetch(`${baseUrl}/api/terminal/sessions/${session.id}`);
    assert.equal(one.status, 200);
    const missing = await fetch(`${baseUrl}/api/terminal/sessions/nope`);
    assert.equal(missing.status, 404);

    // Still running: removal is refused.
    const busy = await fetch(`${baseUrl}/api/terminal/sessions/${session.id}`, {
      method: 'DELETE',
    });
    assert.equal(busy.status, 409);

    spawner.children[0].exit(0);
    await new Promise(resolve => setImmediate(resolve));
    const gone = await fetch(`${baseUrl}/api/terminal/sessions/${session.id}`, {
      method: 'DELETE',
    });
    assert.equal(gone.status, 204);
    const after = await fetch(`${baseUrl}/api/terminal/sessions`);
    assert.deepEqual(await after.json(), { sessions: [] });
  } finally {
    terminal.dispose();
    server.close();
  }
});

// e as an A2A agent (ADR-0015): the card at its well-known path and one
// JSON-RPC endpoint, both delegations to `A2aTasks`; and the siblings view
// of a run's spool for the UI.

async function serveWith(
  deps: ServeAppDeps
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
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
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
      await fs.rm(uiDirectory, { recursive: true, force: true });
    },
  };
}

const rpc = (
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {}
) =>
  fetch(`${baseUrl}/a2a`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('without the A2A facade the card is 404 and the endpoint 503', async () => {
  const { baseUrl, close } = await serveWith({});
  try {
    assert.equal(
      (await fetch(`${baseUrl}/.well-known/agent-card.json`)).status,
      404
    );
    assert.equal(
      (await rpc(baseUrl, { jsonrpc: '2.0', id: 1, method: 'ListTasks' }))
        .status,
      503
    );
  } finally {
    await close();
  }
});

function a2aFixture(access: A2aAccess) {
  const spool = fsSync.mkdtempSync(path.join(os.tmpdir(), 'e-serve-a2a-'));
  const launches: string[][] = [];
  const tasks = new A2aTasks({
    spoolDir: spool,
    knownAgent: name => name === 'pi' || name === 'smart-codex',
    defaultAgent: 'pi',
    spawnChild: args => {
      launches.push(args);
      return { exited: new Promise<number>(() => {}), kill: () => {} };
    },
    pollIntervalMs: 20,
    newId: () => `t-${launches.length + 1}`,
  });
  return {
    spool,
    launches,
    tasks,
    deps: {
      a2a: { tasks, access, url: 'http://127.0.0.1:1/a2a' },
      listAgents: () => [
        { name: 'pi', harness: 'pi', model: 'auto/coding', default: true },
        { name: 'smart-codex', harness: 'codex', model: null, default: false },
        {
          name: 'remote',
          harness: 'a2a',
          model: null,
          default: false,
          transport: 'a2a' as const,
        },
      ],
    } satisfies ServeAppDeps,
    dispose: () => {
      tasks.dispose();
      fsSync.rmSync(spool, { recursive: true, force: true });
    },
  };
}

test('the agent card lists the harness agents as skills (not remote ones) and names the endpoint', async () => {
  const fixture = a2aFixture({ enabled: true, requireBearer: false });
  const { baseUrl, close } = await serveWith(fixture.deps);
  try {
    const res = await fetch(`${baseUrl}/.well-known/agent-card.json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('a2a-version'), '1.0');
    const card = (await res.json()) as {
      skills: { id: string }[];
      supportedInterfaces: { url: string }[];
      version: string;
      securitySchemes?: unknown;
    };
    assert.deepEqual(
      card.skills.map(s => s.id),
      ['pi', 'smart-codex']
    );
    assert.equal(card.supportedInterfaces[0].url, 'http://127.0.0.1:1/a2a');
    assert.equal(card.version, E_VERSION);
    assert.equal(card.securitySchemes, undefined);
  } finally {
    await close();
    fixture.dispose();
  }
});

test('SendMessage starts a run and answers {task}; GetTask, ListTasks, CancelTask and the errors of the binding', async () => {
  const fixture = a2aFixture({ enabled: true, requireBearer: false });
  const { baseUrl, close } = await serveWith(fixture.deps);
  try {
    const sent = await rpc(baseUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: {
        message: {
          messageId: 'm',
          role: 'ROLE_USER',
          parts: [{ text: 'Fix it' }],
          metadata: { agent: 'smart-codex' },
        },
      },
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.headers.get('a2a-version'), '1.0');
    const body = (await sent.json()) as {
      id: number;
      result: { task: { id: string; status: { state: string } } };
    };
    assert.equal(body.id, 1);
    assert.equal(body.result.task.status.state, 'TASK_STATE_SUBMITTED');
    assert.deepEqual(fixture.launches[0], [
      'spawn',
      'smart-codex',
      '--detached',
      '--',
      'Fix it',
    ]);
    const taskId = body.result.task.id;

    const got = (await (
      await rpc(baseUrl, {
        jsonrpc: '2.0',
        id: 2,
        method: 'GetTask',
        params: { id: taskId },
      })
    ).json()) as { result: { id: string } };
    assert.equal(got.result.id, taskId);
    const listed = (await (
      await rpc(baseUrl, { jsonrpc: '2.0', id: 3, method: 'ListTasks' })
    ).json()) as { result: { tasks: unknown[] } };
    assert.equal(listed.result.tasks.length, 1);
    const canceled = (await (
      await rpc(baseUrl, {
        jsonrpc: '2.0',
        id: 4,
        method: 'CancelTask',
        params: { id: taskId },
      })
    ).json()) as { result: { id: string } };
    assert.equal(canceled.result.id, taskId);

    const error = async (request: unknown) =>
      (
        (await (await rpc(baseUrl, request)).json()) as {
          error: { code: number };
        }
      ).error.code;
    assert.equal(
      await error({
        jsonrpc: '2.0',
        id: 5,
        method: 'GetTask',
        params: { id: 'nope' },
      }),
      -32001
    );
    assert.equal(
      await error({
        jsonrpc: '2.0',
        id: 6,
        method: 'CreateTaskPushNotificationConfig',
        params: {},
      }),
      -32003
    );
    assert.equal(
      await error({ jsonrpc: '2.0', id: 7, method: 'GetExtendedAgentCard' }),
      -32007
    );
    assert.equal(
      await error({ jsonrpc: '2.0', id: 8, method: 'nope' }),
      -32601
    );
    // The 0.x slash names still work as aliases of the 1.0 RPC names.
    const legacy = (await (
      await rpc(baseUrl, {
        jsonrpc: '2.0',
        id: 10,
        method: 'tasks/get',
        params: { id: taskId },
      })
    ).json()) as { result: { id: string } };
    assert.equal(legacy.result.id, taskId);
    // ListTasks answers the 1.0 ListTasksResponse shape.
    const page = (await (
      await rpc(baseUrl, { jsonrpc: '2.0', id: 11, method: 'ListTasks' })
    ).json()) as {
      result: { tasks: unknown[]; nextPageToken: string; totalSize: number };
    };
    assert.equal(page.result.totalSize, 1);
    assert.equal(page.result.nextPageToken, '');
    assert.equal(await error('not json'), -32700);
    assert.equal(
      await error({
        jsonrpc: '2.0',
        id: 9,
        method: 'SendMessage',
        params: {
          message: { parts: [{ text: 'x' }], metadata: { agent: 'remote' } },
        },
      }),
      -32602
    );
  } finally {
    await close();
    fixture.dispose();
  }
});

test('SendStreamingMessage answers server-sent events: the task, then updates as the run reports, final on completion', async () => {
  const fixture = a2aFixture({ enabled: true, requireBearer: false });
  const { baseUrl, close } = await serveWith(fixture.deps);
  try {
    const res = await rpc(baseUrl, {
      jsonrpc: '2.0',
      id: 'stream-1',
      method: 'SendStreamingMessage',
      params: {
        message: {
          messageId: 'm',
          role: 'ROLE_USER',
          parts: [{ text: 'Fix it' }],
        },
      },
    });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = res.body!.getReader();
    const results: Record<string, unknown>[] = [];
    const readUntil = async (count: number) => {
      while (results.length < count) {
        const { value, done } = await reader.read();
        if (done) return;
        for (const event of parser.push(
          decoder.decode(value, { stream: true })
        )) {
          const response = JSON.parse(event.data) as {
            id: string;
            result: Record<string, unknown>;
          };
          assert.equal(response.id, 'stream-1');
          results.push(response.result);
        }
      }
    };
    await readUntil(1);
    assert.ok('task' in results[0]);
    writeStatus(fixture.spool, 'a2a-001', {
      status: 'running',
      branch: 'e/pi/fix-it-1',
      updatedAt: 't',
    });
    await readUntil(2);
    assert.ok('statusUpdate' in results[1]);
    writeStatus(fixture.spool, 'a2a-001', {
      status: 'done',
      branch: 'e/pi/fix-it-1',
      exitCode: 0,
      pushed: false,
      updatedAt: 't',
    });
    await readUntil(4);
    assert.ok('artifactUpdate' in results[2]);
    assert.deepEqual(
      (
        results[3] as {
          statusUpdate: { final: boolean; status: { state: string } };
        }
      ).statusUpdate.final,
      true
    );
    assert.equal(
      (results[3] as { statusUpdate: { status: { state: string } } })
        .statusUpdate.status.state,
      'TASK_STATE_COMPLETED'
    );
    // The server ends the stream after the final event.
    const { done } = await reader.read();
    assert.equal(done, true);
  } finally {
    await close();
    fixture.dispose();
  }
});

test('with a bearer token the endpoint refuses requests without it; the card advertises the scheme; disabled access is 404 and 503', async () => {
  const secured = a2aFixture({
    enabled: true,
    requireBearer: true,
    token: 's3cret',
  });
  const one = await serveWith(secured.deps);
  try {
    const card = (await (
      await fetch(`${one.baseUrl}/.well-known/agent-card.json`)
    ).json()) as { securityRequirements: unknown };
    assert.deepEqual(card.securityRequirements, [
      { schemes: { bearer: { list: [] } } },
    ]);
    assert.equal(
      (await rpc(one.baseUrl, { jsonrpc: '2.0', id: 1, method: 'ListTasks' }))
        .status,
      401
    );
    assert.equal(
      (
        await rpc(
          one.baseUrl,
          { jsonrpc: '2.0', id: 1, method: 'ListTasks' },
          { authorization: 'Bearer wrong' }
        )
      ).status,
      401
    );
    assert.equal(
      (
        await rpc(
          one.baseUrl,
          { jsonrpc: '2.0', id: 1, method: 'ListTasks' },
          { authorization: 'Bearer s3cret' }
        )
      ).status,
      200
    );
  } finally {
    await one.close();
    secured.dispose();
  }
  const off = a2aFixture({ enabled: false, reason: 'beyond loopback' });
  const two = await serveWith(off.deps);
  try {
    assert.equal(
      (await fetch(`${two.baseUrl}/.well-known/agent-card.json`)).status,
      404
    );
    const res = await rpc(two.baseUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'ListTasks',
    });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'beyond loopback' });
  } finally {
    await two.close();
    off.dispose();
  }
});

test('the siblings of a run with a broker come from its spool, as a snapshot and as server-sent events', async () => {
  const worktreesDir = fsSync.mkdtempSync(
    path.join(os.tmpdir(), 'e-serve-wt-')
  );
  const spool = brokerSpoolDirFor(worktreesDir, 'e-pi-task-1');
  ensureSpool(spool);
  writeRunInfo(spool, {
    name: 'e-pi-task-1',
    branch: 'e/pi/task-1',
    agent: 'pi',
    role: 'parent',
    maxSiblings: 3,
  });
  writeRequest(spool, {
    id: 'sib-001',
    agent: 'r',
    prompt: 'p',
    requestedAt: 't',
  });
  const git = {
    listRunRefs: (): RunRef[] => [
      { name: 'e/pi/task-1', sha: 'abc', committerDate: 't', subject: 's' },
    ],
  } as unknown as Git;
  const { baseUrl, close } = await serveWith({ git, worktreesDir });
  try {
    const snapshot = await fetch(`${baseUrl}/api/runs/e/pi/task-1/siblings`);
    assert.equal(snapshot.status, 200);
    const body = (await snapshot.json()) as StatusResponse;
    assert.equal(body.run?.name, 'e-pi-task-1');
    assert.deepEqual(
      body.siblings.map(s => [s.id, s.taskState]),
      [['sib-001', 'submitted']]
    );
    // A run without a spool has no siblings.
    const none = (await (
      await fetch(`${baseUrl}/api/runs/e/pi/other-2/siblings`)
    ).json()) as StatusResponse;
    assert.deepEqual(none, { run: null, siblings: [] });
    const events = await fetch(
      `${baseUrl}/api/runs/e/pi/task-1/siblings/events`
    );
    assert.equal(events.headers.get('content-type'), 'text/event-stream');
    const reader = events.body!.getReader();
    const { value } = await reader.read();
    const parsed = new SseParser().push(new TextDecoder().decode(value));
    assert.equal(parsed[0].event, 'status');
    assert.equal(
      (JSON.parse(parsed[0].data) as StatusResponse).siblings[0].id,
      'sib-001'
    );
    await reader.cancel();
  } finally {
    await close();
    fsSync.rmSync(worktreesDir, { recursive: true, force: true });
  }
});
