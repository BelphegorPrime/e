import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { BROKER_URL_ENV } from '../contract/constants.js';
import { formatSseEvent } from '../contract/events.js';
import {
  WATCH_TIMEOUT_ENV,
  WATCH_TIMEOUT_MS,
  watchTimeoutMs,
} from '../contract/cliArgs.js';
import type {
  SiblingRecord,
  SiblingState,
  StatusResponse,
  TaskState,
} from '../contract/types.js';

/**
 * `cli.ts` is the `spawn-brother` entry module: it parses no arguments of its
 * own (that is `contract/cliArgs.ts`, tested separately) but decides which
 * broker route each command hits, what it prints, and which exit code the
 * agent sees. It is a script with a top-level `main(...).then(process.exit)`
 * and no exports, so the only way in is to run the compiled file against a
 * fake broker - which is also exactly how the agent runs it.
 */
const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));

/** A port nothing listens on: connecting there is refused immediately. */
const DEAD_BROKER = 'http://127.0.0.1:1';

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {}
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      // The host's own environment must not leak a broker URL into the run.
      env: { ...process.env, [BROKER_URL_ENV]: undefined, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

interface RecordedRequest {
  method: string;
  path: string;
  body: string;
  contentType: string | undefined;
}

interface FakeBroker {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

type Route = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function startBroker(route: Route): Promise<FakeBroker> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        body,
        contentType: req.headers['content-type'],
      });
      route(req, res, body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Opens an SSE stream and leaves it open, the way `GET /status/events` does. */
function openEventStream(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
}

const RUN_STATE: Record<TaskState, SiblingState> = {
  submitted: 'requested',
  working: 'running',
  'input-required': 'done',
  completed: 'done',
  failed: 'failed',
  canceled: 'canceled',
  rejected: 'rejected',
};

function sibling(id: string, taskState: TaskState): SiblingRecord {
  return {
    id,
    agent: 'smart-claude',
    prompt: 'do the thing',
    requestedAt: '2026-09-12T10:00:00.000Z',
    status: RUN_STATE[taskState],
    taskState,
  };
}

function statusEvent(...siblings: SiblingRecord[]): string {
  const body: StatusResponse = { run: null, siblings };
  return formatSseEvent('status', body);
}

/**
 * The exit codes `SPAWN_BROTHER_USAGE` promises the agent, which is the whole
 * point of this script: an agent branches on them without a terminal to read.
 * They were unreachable from inside the event stream until the loop stopped
 * aborting the fetch before returning - see the module doc on `watch`.
 */
const FOUND = 0;
const REFUSED = 1;
const TIMED_OUT = 4;
const GAVE_UP = /--watch gave up after/;

test('spawn-brother: --help prints the usage and exits 0 without a broker', async () => {
  for (const args of [[], ['--help'], ['-h']]) {
    const result = await runCli(args);
    assert.equal(result.code, 0, `exit code for ${JSON.stringify(args)}`);
    assert.match(result.stdout, /usage: node spawn-brother\.mjs <agent>/);
    assert.equal(result.stderr, '');
  }
});

test('spawn-brother: a usage error exits 2 with the reason and the usage', async () => {
  const missingId = await runCli(['--merge']);
  assert.equal(missingId.code, 2);
  assert.match(missingId.stderr, /--merge takes exactly one sibling id\./);
  assert.match(missingId.stderr, /usage: node spawn-brother\.mjs <agent>/);

  const unknown = await runCli(['--frobnicate']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown option "--frobnicate"\./);
});

test('spawn-brother: a command without $E_BROKER_URL exits 2 and says this run has no broker', async () => {
  const result = await runCli(['--status']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /\$E_BROKER_URL is not set/);
  assert.match(result.stderr, /not an e run with a runtime-broker/);
});

test('spawn-brother: a spawn POSTs {agent, prompt} as JSON to /spawn and exits 0 on acceptance', async () => {
  const broker = await startBroker((_req, res) =>
    sendJson(res, 202, {
      id: 'sib-001',
      status: 'requested',
      statusPath: '/status/sib-001',
    })
  );
  try {
    const result = await runCli(
      ['smart-claude', 'add a test for the parser'],
      // A trailing slash in the run's env must not produce `//spawn`.
      { [BROKER_URL_ENV]: `${broker.url}/` }
    );
    assert.equal(result.code, 0);
    assert.deepEqual(broker.requests, [
      {
        method: 'POST',
        path: '/spawn',
        body: '{"agent":"smart-claude","prompt":"add a test for the parser"}',
        contentType: 'application/json',
      },
    ]);
    // The broker's answer is handed to the agent verbatim.
    assert.match(result.stdout, /"id":"sib-001"/);
  } finally {
    await broker.close();
  }
});

test("spawn-brother: the broker's refusal is printed and exits 1", async () => {
  const broker = await startBroker((_req, res) =>
    sendJson(res, 429, { error: 'Too many siblings in flight (max 2).' })
  );
  try {
    const result = await runCli(['smart-claude', 'one more'], {
      [BROKER_URL_ENV]: broker.url,
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Too many siblings in flight/);
    assert.equal(result.stderr, '');
  } finally {
    await broker.close();
  }
});

test('spawn-brother: --status hits /status, and /status/<id> when an id is given', async () => {
  const broker = await startBroker((_req, res) =>
    sendJson(res, 200, { run: null, siblings: [] })
  );
  try {
    assert.equal(
      (await runCli(['--status'], { [BROKER_URL_ENV]: broker.url })).code,
      0
    );
    assert.equal(
      (await runCli(['--status', 'sib-001'], { [BROKER_URL_ENV]: broker.url }))
        .code,
      0
    );
    assert.deepEqual(
      broker.requests.map(request => `${request.method} ${request.path}`),
      ['GET /status', 'GET /status/sib-001']
    );
  } finally {
    await broker.close();
  }
});

test('spawn-brother: --merge and --cancel POST to their route with no body', async () => {
  const broker = await startBroker((_req, res) =>
    sendJson(res, 202, { id: 'sib-001', status: 'merge-requested' })
  );
  try {
    await runCli(['--merge', 'sib-001'], { [BROKER_URL_ENV]: broker.url });
    await runCli(['--cancel', 'sib-002'], { [BROKER_URL_ENV]: broker.url });
    assert.deepEqual(broker.requests, [
      {
        method: 'POST',
        path: '/merge/sib-001',
        body: '',
        contentType: undefined,
      },
      {
        method: 'POST',
        path: '/cancel/sib-002',
        body: '',
        contentType: undefined,
      },
    ]);
  } finally {
    await broker.close();
  }
});

test('spawn-brother: a sibling id is percent-encoded, so it cannot escape its route', async () => {
  const broker = await startBroker((_req, res) =>
    sendJson(res, 404, { error: 'x' })
  );
  try {
    const env = { [BROKER_URL_ENV]: broker.url };
    await runCli(['--status', '../run.json'], env);
    await runCli(['--merge', '../../etc/passwd'], env);
    await runCli(['--cancel', 'sib-1?force=1'], env);
    assert.deepEqual(
      broker.requests.map(request => request.path),
      [
        '/status/..%2Frun.json',
        '/merge/..%2F..%2Fetc%2Fpasswd',
        '/cancel/sib-1%3Fforce%3D1',
      ]
    );
  } finally {
    await broker.close();
  }
});

test('spawn-brother: a broker that does not answer exits 3 with the file-a-task fallback', async () => {
  const result = await runCli(['smart-claude', 'do it'], {
    [BROKER_URL_ENV]: DEAD_BROKER,
  });
  assert.equal(result.code, 3);
  assert.match(
    result.stderr,
    /the runtime-broker at http:\/\/127\.0\.0\.1:1 did not answer/
  );
  assert.match(
    result.stderr,
    /record the task as a file in the worktree instead/
  );
  assert.equal(result.stdout, '');
});

test('spawn-brother: --watch reports what already needs attention on the first snapshot', async () => {
  const broker = await startBroker((_req, res) => {
    openEventStream(res);
    // Keep-alive comments and other event names must not be mistaken for a
    // snapshot; only `status` events carry a StatusResponse.
    res.write(': keep-alive\n\n');
    res.write(formatSseEvent('hello', { note: 'not a status' }));
    res.write(
      statusEvent(
        sibling('sib-001', 'working'),
        sibling('sib-002', 'completed')
      )
    );
  });
  try {
    const result = await runCli(['--watch'], { [BROKER_URL_ENV]: broker.url });
    assert.deepEqual(
      (JSON.parse(result.stdout) as SiblingRecord[]).map(record => record.id),
      ['sib-002']
    );
    assert.deepEqual(
      broker.requests.map(request => `${request.method} ${request.path}`),
      ['GET /status/events']
    );
    assert.equal(result.code, FOUND);
  } finally {
    await broker.close();
  }
});

test('spawn-brother: --watch reports the sibling and says nothing else', async () => {
  const broker = await startBroker((_req, res) => {
    openEventStream(res);
    res.write(statusEvent(sibling('sib-001', 'completed')));
  });
  try {
    const result = await runCli(['--watch'], { [BROKER_URL_ENV]: broker.url });
    assert.match(result.stdout, /"id":"sib-001"/);
    // The regression: it used to print the answer and then contradict it.
    assert.doesNotMatch(result.stderr, GAVE_UP);
    assert.equal(result.code, FOUND);
  } finally {
    await broker.close();
  }
});

test('spawn-brother: --watch keeps waiting through snapshots where nothing changed', async () => {
  const broker = await startBroker((_req, res) => {
    openEventStream(res);
    res.write(
      statusEvent(sibling('sib-001', 'working'), sibling('sib-002', 'working'))
    );
    // Unchanged: still nothing to report.
    res.write(
      statusEvent(sibling('sib-001', 'working'), sibling('sib-002', 'working'))
    );
    res.write(
      statusEvent(sibling('sib-001', 'working'), sibling('sib-002', 'failed'))
    );
  });
  try {
    const result = await runCli(['--watch'], { [BROKER_URL_ENV]: broker.url });
    assert.deepEqual(
      (JSON.parse(result.stdout) as SiblingRecord[]).map(record => record.id),
      ['sib-002']
    );
    assert.equal(result.code, FOUND);
  } finally {
    await broker.close();
  }
});

test('spawn-brother: --watch <id> follows only that sibling', async () => {
  const broker = await startBroker((_req, res) => {
    openEventStream(res);
    res.write(
      statusEvent(sibling('sib-001', 'working'), sibling('sib-002', 'working'))
    );
    res.write(
      statusEvent(
        sibling('sib-001', 'completed'),
        sibling('sib-002', 'working')
      )
    );
    res.write(
      statusEvent(
        sibling('sib-001', 'completed'),
        sibling('sib-002', 'input-required')
      )
    );
  });
  try {
    const result = await runCli(['--watch', 'sib-002'], {
      [BROKER_URL_ENV]: broker.url,
    });
    const reported = JSON.parse(result.stdout) as SiblingRecord[];
    // sib-001 completed in between and is not reported: the id narrows the watch.
    assert.deepEqual(
      reported.map(record => [record.id, record.taskState]),
      [['sib-002', 'input-required']]
    );
    assert.equal(result.code, FOUND);
  } finally {
    await broker.close();
  }
});

test('spawn-brother: --watch <id> refuses an id this run never requested', async () => {
  const broker = await startBroker((_req, res) => {
    openEventStream(res);
    res.write(statusEvent(sibling('sib-001', 'working')));
  });
  try {
    const result = await runCli(['--watch', 'sib-404'], {
      [BROKER_URL_ENV]: broker.url,
    });
    assert.match(
      result.stderr,
      /no sibling "sib-404" was requested from this run\./
    );
    assert.equal(result.stdout, '');
    // A refusal, and only that: no second, contradictory line behind it.
    assert.equal(result.code, REFUSED);
    assert.doesNotMatch(result.stderr, GAVE_UP);
  } finally {
    await broker.close();
  }
});

test('spawn-brother: --watch prints the broker refusal and exits 1 when the stream is not opened', async () => {
  const broker = await startBroker((_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Depth limit: a sibling run may not spawn children',
      })
    );
  });
  try {
    const result = await runCli(['--watch'], { [BROKER_URL_ENV]: broker.url });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Depth limit/);
  } finally {
    await broker.close();
  }
});

test('spawn-brother: --watch against a broker that does not answer exits 3', async () => {
  const result = await runCli(['--watch'], { [BROKER_URL_ENV]: DEAD_BROKER });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /did not answer/);
});

test('spawn-brother: --watch exits 4 for the reason it documents, and says so once', async () => {
  // The genuine timeout, reachable now that the wait is configurable: the
  // broker holds the stream open and never reports anything worth waking for.
  const broker = await startBroker((_req, res) => {
    openEventStream(res);
    res.write(statusEvent(sibling('sib-001', 'working')));
  });
  try {
    const result = await runCli(['--watch'], {
      [BROKER_URL_ENV]: broker.url,
      [WATCH_TIMEOUT_ENV]: '300',
    });
    assert.equal(result.stdout, '');
    assert.match(result.stderr, GAVE_UP);
    assert.equal(result.code, TIMED_OUT);
  } finally {
    await broker.close();
  }
});

test('spawn-brother: a junk watch timeout falls back to the default rather than refusing', () => {
  // A mistyped override must not stop an agent from watching its siblings.
  assert.equal(watchTimeoutMs({}), WATCH_TIMEOUT_MS);
  assert.equal(watchTimeoutMs({ [WATCH_TIMEOUT_ENV]: '' }), WATCH_TIMEOUT_MS);
  assert.equal(
    watchTimeoutMs({ [WATCH_TIMEOUT_ENV]: 'soon' }),
    WATCH_TIMEOUT_MS
  );
  assert.equal(watchTimeoutMs({ [WATCH_TIMEOUT_ENV]: '0' }), WATCH_TIMEOUT_MS);
  assert.equal(watchTimeoutMs({ [WATCH_TIMEOUT_ENV]: '-5' }), WATCH_TIMEOUT_MS);
  assert.equal(watchTimeoutMs({ [WATCH_TIMEOUT_ENV]: '250' }), 250);
});
