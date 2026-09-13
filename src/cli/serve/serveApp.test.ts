import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { A2aAccess } from '../../engine/a2a/access.js';
import { A2aTasks } from '../../engine/a2a/tasks.js';
import type { RunCommit, RunRef } from '../../ports/git/index.js';
import { InMemoryGit } from '../../ports/git/memory.js';
import { SseParser } from '../../sidecars/broker/contract/events.js';
import {
  readRequest,
  writeRunInfo,
  writeStatus,
} from '../../sidecars/broker/contract/spool.js';
import type { StatusResponse } from '../../sidecars/broker/contract/types.js';
import { brokerSpoolDirFor } from '../../engine/runs/runBroker.js';
import { fromBranch } from '../../core/identity/runName.js';
import { E_VERSION } from '../../shared/version.js';
import {
  createServeApp,
  startServeServer,
  type ServeAppDeps,
} from './serveApp.js';
import { TerminalSessions } from './terminalSessions.js';
import { fakeEngine, scriptedSpawner } from './terminalSessions.testSupport.js';

/**
 * Boots the BFF on an ephemeral port and runs `fn` against it. No temp
 * directory: `uiDirectory` is a dependency like any other, so an API test
 * simply leaves it out.
 */
async function withServeApp(
  deps: ServeAppDeps,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = await startServeServer(createServeApp(deps), '127.0.0.1', 0);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
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
  ],
};

test('serve app answers the API and, given a UI directory, falls back to index.html', async () => {
  // The one test that needs assets on disk: serving them is what it asserts.
  const uiDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'e-ui-'));
  await fs.writeFile(
    path.join(uiDirectory, 'index.html'),
    '<!doctype html><title>e</title>'
  );
  try {
    await withServeApp({ uiDirectory }, async baseUrl => {
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
    });
  } finally {
    await fs.rm(uiDirectory, { recursive: true, force: true });
  }
});

test('serve app publishes the OmniRoute embed port via /api/info', async () => {
  await withServeApp({ omniRouteEmbedPort: 8081 }, async baseUrl => {
    const info = await fetch(`${baseUrl}/api/info`);
    assert.deepEqual(await info.json(), {
      name: 'e',
      version: E_VERSION,
      omniRouteEmbedPort: 8081,
      terminal: false,
    });
  });
});

// --- the runs routes: status codes over `RunsApi`, whose reads are tested in
// runsApi.test.ts without any of this.

test('/api/runs serves the index and the per-run views', async () => {
  await withServeApp(
    { git: new InMemoryGit({ refs: runRefs, log: runCommits }) },
    async baseUrl => {
      const index = (await (await fetch(`${baseUrl}/api/runs`)).json()) as {
        runs: Array<{ branch: string }>;
      };
      assert.deepEqual(
        index.runs.map(run => run.branch),
        ['e/claudeCode/fix-typos-2', 'e/claudeCode/fix-typos-1']
      );

      const status = await fetch(
        `${baseUrl}/api/runs/e/claudeCode/fix-typos-2`
      );
      assert.equal(status.status, 200);
      assert.equal(
        ((await status.json()) as { commits: number }).commits,
        runCommits['e/claudeCode/fix-typos-2']!.length
      );

      const logs = await fetch(
        `${baseUrl}/api/runs/e/claudeCode/fix-typos-2/logs`
      );
      assert.equal(logs.status, 200);
      assert.deepEqual(await logs.json(), {
        branch: 'e/claudeCode/fix-typos-2',
        commits: runCommits['e/claudeCode/fix-typos-2'],
      });
    }
  );
});

test('/api/runs is 404 for an unknown or non-run branch', async () => {
  await withServeApp(
    { git: new InMemoryGit({ refs: runRefs, log: runCommits }) },
    async baseUrl => {
      for (const route of [
        '/api/runs/e/claudeCode/never-ran-9',
        '/api/runs/e/claudeCode/never-ran-9/logs',
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
    {
      git: new InMemoryGit({
        refs: runRefs,
        fail: { listRunRefs: 'not a repository' },
      }),
    },
    async baseUrl => {
      const res = await fetch(`${baseUrl}/api/runs`);
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: 'not a repository' });
    }
  );
});

test('the siblings view answers a snapshot and a server-sent event stream', async () => {
  // No spool anywhere under this directory: a run without one has no siblings,
  // which is exactly what both shapes have to say.
  const worktreesDir = path.join(os.tmpdir(), 'e-serve-app-no-spools');
  await withServeApp(
    { git: new InMemoryGit({ refs: [] }), worktreesDir },
    async baseUrl => {
      const snapshot = await fetch(`${baseUrl}/api/runs/e/pi/task-1/siblings`);
      assert.equal(snapshot.status, 200);
      assert.deepEqual(await snapshot.json(), { run: null, siblings: [] });

      const events = await fetch(
        `${baseUrl}/api/runs/e/pi/task-1/siblings/events`
      );
      assert.equal(events.headers.get('content-type'), 'text/event-stream');
      const reader = events.body!.getReader();
      const { value } = await reader.read();
      const parsed = new SseParser().push(new TextDecoder().decode(value));
      assert.equal(parsed[0].event, 'status');
      assert.deepEqual(JSON.parse(parsed[0].data) as StatusResponse, {
        run: null,
        siblings: [],
      });
      await reader.cancel();
    }
  );
});

// --- manual child requests (ADR-0013, ticket 09) -----------------------------

// The one sanctioned write path in the otherwise read-only runs namespace
// (ADR-0010): the host requests a sibling of a live parent run, exactly what
// `e spawn --parent <branch>` does, so the parent's SiblingConsumer picks it
// up like a broker sibling. A live parent is a worktree whose broker spool
// carries run.json naming role `parent`.

test('POST /api/runs/:branch/siblings enqueues a manual child for a live parent run', async () => {
  const worktreesDir = fsSync.mkdtempSync(
    path.join(os.tmpdir(), 'e-serve-spawn-')
  );
  try {
    const branch = fromBranch('e/dev/parent-1');
    assert.ok(branch);
    fsSync.mkdirSync(path.join(worktreesDir, 'e', 'dev', 'parent-1'), {
      recursive: true,
    });
    const spool = brokerSpoolDirFor(worktreesDir, branch);
    fsSync.mkdirSync(spool, { recursive: true });
    writeRunInfo(spool, {
      name: branch.name,
      branch: branch.branch,
      agent: 'dev',
      role: 'parent' as const,
      maxSiblings: 3,
    });

    await withServeApp(
      { git: new InMemoryGit({ refs: [] }), worktreesDir },
      async baseUrl => {
        const accepted = await fetch(
          `${baseUrl}/api/runs/e/dev/parent-1/siblings`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ agent: 'pi', prompt: 'write docs' }),
          }
        );
        assert.equal(accepted.status, 201);
        assert.deepEqual(await accepted.json(), {
          id: 'sib-001',
          status: 'requested',
          statusPath: '/status/sib-001',
        });
        // The request landed in the parent's spool as any broker sibling would.
        const saved = readRequest(spool, 'sib-001');
        assert.ok(saved);
        assert.equal(saved.agent, 'pi');
        assert.equal(saved.prompt, 'write docs');
      }
    );
  } finally {
    fsSync.rmSync(worktreesDir, { recursive: true, force: true });
  }
});

test('POST /api/runs/:branch/siblings refuses a malformed body with 400', async () => {
  const worktreesDir = fsSync.mkdtempSync(
    path.join(os.tmpdir(), 'e-serve-spawn-')
  );
  try {
    await withServeApp(
      { git: new InMemoryGit({ refs: [] }), worktreesDir },
      async baseUrl => {
        const missingAgent = await fetch(
          `${baseUrl}/api/runs/e/dev/parent-1/siblings`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: 'write docs' }),
          }
        );
        assert.equal(missingAgent.status, 400);
        const nonStringPrompt = await fetch(
          `${baseUrl}/api/runs/e/dev/parent-1/siblings`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ agent: 'pi', prompt: 42 }),
          }
        );
        assert.equal(nonStringPrompt.status, 400);
      }
    );
  } finally {
    fsSync.rmSync(worktreesDir, { recursive: true, force: true });
  }
});

// --- browser terminal routes (ADR-0014) --------------------------------------

test('terminal routes answer 503 when no session manager is wired', async () => {
  await withServeApp({ listAgents: () => [] }, async baseUrl => {
    const list = await fetch(`${baseUrl}/api/terminal/sessions`);
    assert.equal(list.status, 503);
    const start = await fetch(`${baseUrl}/api/terminal/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'pi' }),
    });
    assert.equal(start.status, 503);
  });
});

test('terminal routes list agents, start, inspect and remove sessions', async () => {
  const spawner = scriptedSpawner();
  const terminal = new TerminalSessions({
    engine: fakeEngine({ containers: [] }),
    spawnChild: spawner.spawn,
    pollIntervalMs: 1000,
    listSkills: () => ['caveman', 'web-search'],
    listMcpServers: () => [
      { name: 'everything', transport: 'container' },
      { name: 'hosted', transport: 'remote' },
    ],
  });
  try {
    await withServeApp(
      {
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
      },
      async baseUrl => {
        const info = await fetch(`${baseUrl}/api/info`);
        assert.equal(
          ((await info.json()) as { terminal: boolean }).terminal,
          true
        );

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

        const options = await fetch(`${baseUrl}/api/terminal/options`);
        assert.deepEqual(await options.json(), {
          skills: ['caveman', 'web-search'],
          mcp: [
            { name: 'everything', transport: 'container' },
            { name: 'hosted', transport: 'remote' },
          ],
        });

        const advanced = await fetch(`${baseUrl}/api/terminal/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            agent: 'smart-pi',
            name: 'with-tools',
            skills: ['caveman'],
            mcp: ['everything'],
          }),
        });
        assert.equal(advanced.status, 201);
        assert.deepEqual(spawner.calls[1], [
          'spawn',
          'smart-pi',
          '--name',
          'with-tools',
          '--skill',
          'caveman',
          '--mcp',
          'everything',
        ]);

        const rejected = await fetch(`${baseUrl}/api/terminal/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            agent: 'smart-pi',
            skills: ['ghost-skill'],
          }),
        });
        assert.equal(rejected.status, 400);

        const list = await fetch(`${baseUrl}/api/terminal/sessions`);
        const listed = (await list.json()) as {
          sessions: Array<{ id: string }>;
        };
        assert.equal(listed.sessions.length, 2);
        assert.ok(listed.sessions.map(entry => entry.id).includes(session.id));

        const one = await fetch(
          `${baseUrl}/api/terminal/sessions/${session.id}`
        );
        assert.equal(one.status, 200);
        const missing = await fetch(`${baseUrl}/api/terminal/sessions/nope`);
        assert.equal(missing.status, 404);

        // Still running: removal is refused.
        const busy = await fetch(
          `${baseUrl}/api/terminal/sessions/${session.id}`,
          { method: 'DELETE' }
        );
        assert.equal(busy.status, 409);

        spawner.children[0].exit(0);
        await new Promise(resolve => setImmediate(resolve));
        const gone = await fetch(
          `${baseUrl}/api/terminal/sessions/${session.id}`,
          { method: 'DELETE' }
        );
        assert.equal(gone.status, 204);
        spawner.children[1].exit(0);
        await new Promise(resolve => setImmediate(resolve));
        const advancedId = (
          (await advanced.json()) as {
            session: { id: string };
          }
        ).session.id;
        const advancedGone = await fetch(
          `${baseUrl}/api/terminal/sessions/${advancedId}`,
          { method: 'DELETE' }
        );
        assert.equal(advancedGone.status, 204);
        const after = await fetch(`${baseUrl}/api/terminal/sessions`);
        assert.deepEqual(await after.json(), { sessions: [] });
      }
    );
  } finally {
    terminal.dispose();
  }
});

// e as an A2A agent (ADR-0015): the card at its well-known path and one
// JSON-RPC endpoint, both delegations to `A2aTasks`.

async function serveWith(
  deps: ServeAppDeps
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = await startServeServer(createServeApp(deps), '127.0.0.1', 0);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      }),
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
  // The A2A facade owns a spool of its own (ADR-0015); the tasks need it, the
  // routes do not.
  const spool = fsSync.mkdtempSync(path.join(os.tmpdir(), 'e-serve-a2a-'));
  const launches: string[][] = [];
  const tasks = new A2aTasks({
    spoolDir: spool,
    knownAgent: name => name === 'pi' || name === 'smart-codex',
    defaultAgent: 'pi',
    launch: ({ args }) => {
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
