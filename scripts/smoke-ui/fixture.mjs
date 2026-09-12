// The fixture BFF the smoke test runs the built UI against: `createServeApp`
// from dist/serve with deterministic fakes for everything its routes read -
// git run refs, Store agents, the egress API, terminal sessions - so every
// page renders the same on every machine and the test needs no Store, no
// container engine and no git state. `--url` skips this and tests a live
// `e serve` instead.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = seed => seed.repeat(40).slice(0, 40);

/** Run branches as `Git.listRunRefs('e')` returns them: local, pushed (both twins), remote-only. */
export const RUN_REFS = [
  {
    name: 'e/pi/fix-login-redirect-1',
    sha: sha('a1'),
    committerDate: '2026-03-04T10:15:00Z',
    subject: 'fix: redirect to the requested page after login',
  },
  {
    name: 'origin/e/pi/fix-login-redirect-1',
    sha: sha('a1'),
    committerDate: '2026-03-04T10:15:00Z',
    subject: 'fix: redirect to the requested page after login',
  },
  {
    name: 'e/pi/add-signup-validation-2',
    sha: sha('b2'),
    committerDate: '2026-03-03T16:40:00Z',
    subject: 'feat(signup): validate the form and cover it with tests',
  },
  {
    name: 'origin/e/smart-codex/refactor-store-paths-1',
    sha: sha('c3'),
    committerDate: '2026-03-02T09:05:00Z',
    subject: 'refactor(store): one module for the store paths',
  },
  {
    name: 'e/pi/run-7',
    sha: sha('d4'),
    committerDate: '2026-03-01T18:30:00Z',
    subject: 'e: run output for e/pi/run-7',
  },
];

/** `Git.runLog(branch)`: newest first. */
export const RUN_COMMITS = Object.fromEntries(
  RUN_REFS.map(ref => [
    ref.name,
    [
      { sha: ref.sha, subject: ref.subject, committerDate: ref.committerDate },
      {
        sha: sha('0f'),
        subject: 'chore: checkpoint before the run',
        committerDate: '2026-03-01T08:00:00Z',
      },
    ],
  ])
);

/** The Store's agents (`/api/agents`): a default harness agent, a second one, a remote A2A agent. */
export const AGENTS = [
  { name: 'pi', harness: 'pi', model: 'auto/coding', default: true },
  {
    name: 'smart-codex',
    harness: 'codex',
    model: 'gpt-5-codex',
    default: false,
  },
  {
    name: 'reviewer',
    harness: 'a2a',
    model: null,
    default: false,
    transport: 'a2a',
  },
];

export const EGRESS_URL = 'http://egress.fixture';

/** `GET /logs/squashed` of the egress API. */
export const SQUASHED_LOGS = [
  ['registry.npmjs.org', 645],
  ['api.openai.com', 402],
  ['github.com', 318],
  ['api.anthropic.com', 97],
  ['pypi.org', 41],
  ['example.com', 3],
].map(([domain, count]) => ({
  domain,
  count,
  firstSeen: '2026-03-04T08:00:00.000Z',
  lastSeen: '2026-03-04T11:59:00.000Z',
}));

export const BLACKLIST = ['tracker.example.net', 'ads.example.org'];

/** `/api/terminal/options`: the skills and MCP servers a browser-started run may add. */
export const TERMINAL_OPTIONS = {
  skills: ['conventional-commits', 'spawn-brother', 'web-search'],
  mcp: [
    { name: 'filesystem', transport: 'container' },
    { name: 'searxng', transport: 'container' },
    { name: 'docs', transport: 'remote' },
  ],
};

/** The `Git` port with fixed refs; the write operations a BFF never calls throw. */
export class FixtureGit {
  isRepo() {
    return true;
  }
  headSha() {
    return sha('ee');
  }
  currentBranch() {
    return 'main';
  }
  listRunBranches() {
    return RUN_REFS.map(ref => ref.name);
  }
  listRunRefs() {
    return RUN_REFS;
  }
  runLog(branch) {
    return RUN_COMMITS[branch] ?? [];
  }
  branchExists(branch) {
    return RUN_REFS.some(ref => ref.name === branch);
  }
  isDirty() {
    return false;
  }
  hasCommitsBeyondBase() {
    return false;
  }
  mergeInProgress() {
    return false;
  }
  addWorktree() {
    throw new Error('FixtureGit is read-only');
  }
  commitAll() {
    throw new Error('FixtureGit is read-only');
  }
  push() {
    throw new Error('FixtureGit is read-only');
  }
  removeWorktree() {
    throw new Error('FixtureGit is read-only');
  }
  merge() {
    throw new Error('FixtureGit is read-only');
  }
}

/**
 * A `fetch` for the BFF's egress proxy: answers the egress API's routes from
 * memory (the blacklist mutates), 404 for anything else.
 */
export function fixtureFetch(blacklist = [...BLACKLIST]) {
  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    if (url.pathname === '/logs/squashed' && method === 'GET') {
      return json(200, SQUASHED_LOGS);
    }
    if (url.pathname === '/blacklist/domains') {
      if (method === 'GET') return json(200, { domains: blacklist });
      if (method === 'POST') {
        const { domain } = JSON.parse(init.body ?? '{}');
        if (typeof domain !== 'string' || domain === '') {
          return json(400, { error: 'Missing domain' });
        }
        if (!blacklist.includes(domain)) blacklist.push(domain);
        return json(200, { status: 'ok' });
      }
    }
    const remove = /^\/blacklist\/domains\/([^/]+)$/.exec(url.pathname);
    if (remove && method === 'DELETE') {
      const domain = decodeURIComponent(remove[1]);
      const index = blacklist.indexOf(domain);
      if (index !== -1) blacklist.splice(index, 1);
      return json(200, { status: 'ok' });
    }
    return json(404, { error: 'Not found' });
  };
}

/** The `TerminalSessions` surface the BFF uses, with an engine "present" and no way to really start a run. */
export function fixtureTerminal() {
  const sessions = new Map();
  let counter = 0;
  return {
    engineAvailable: true,
    options() {
      return TERMINAL_OPTIONS;
    },
    list() {
      return [...sessions.values()];
    },
    get(id) {
      return sessions.get(id);
    },
    start(request) {
      const id = `fixture-${++counter}`;
      const info = {
        id,
        agent: request.agent,
        slug: request.slug ?? `run-${counter}`,
        phase: 'exited',
        exitCode: 0,
        createdAt: '2026-03-04T12:00:00.000Z',
      };
      sessions.set(id, info);
      return info;
    },
    remove(id) {
      sessions.delete(id);
    },
    dispose() {
      sessions.clear();
    },
  };
}

/** The `ServeAppDeps` of the fixture; `worktreesDir` is a fresh temp dir (no sibling spools). */
export function fixtureDeps() {
  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-smoke-ui-'));
  return {
    git: new FixtureGit(),
    listAgents: () => AGENTS,
    egressApiUrl: EGRESS_URL,
    fetchImpl: fixtureFetch(),
    terminal: fixtureTerminal(),
    omniRouteEmbedPort: null,
    worktreesDir,
  };
}

/** The built files the fixture serves; the error names the build step. */
export function requireBuild(root) {
  const uiDir = path.join(root, 'dist', 'ui');
  const serveModule = path.join(root, 'dist', 'serve', 'serve.js');
  const missing = [
    [path.join(uiDir, 'index.html'), 'npm run build:ui'],
    [serveModule, 'npm run build:ts'],
  ].filter(([file]) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(
      `The smoke test needs the built UI and server. Missing: ${missing
        .map(([file, step]) => `${path.relative(root, file)} (${step})`)
        .join(', ')}. Run "npm run build:dev" first.`
    );
  }
  return { uiDir, serveModule };
}

/** Starts the fixture BFF on a free loopback port; `close` stops it and removes its temp dir. */
export async function startFixture(root) {
  const { uiDir, serveModule } = requireBuild(root);
  const { createServeApp, startServeServer } = await import(
    pathToFileURL(serveModule).href
  );
  const deps = fixtureDeps();
  const server = await startServeServer(
    createServeApp(uiDir, deps),
    '127.0.0.1',
    0
  );
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close(error => {
          fs.rmSync(deps.worktreesDir, { recursive: true, force: true });
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
