import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  DEFAULT_QUEUE_CONFIG,
  type QueueConfig,
} from '../../core/store/config.js';
import type { Trigger } from '../../core/trigger/index.js';
import { signWebhookBody } from '../../core/trigger/webhook.js';
import type { ChildLauncher } from '../../engine/runs/childRun.js';
import { RunQueue } from '../../engine/queue/runQueue.js';
import {
  listLedger,
  listQueue,
  runsDirs,
  type RunsDirs,
} from '../../engine/queue/runsSpool.js';
import {
  handleWebhookDelivery,
  openWebhookListener,
  startWebhookServer,
  webhookPortFor,
  WEBHOOK_PAYLOAD_MAX_BYTES,
  type WebhookServerDeps,
} from './webhookServer.js';

/*
 * The webhook listener (ADR-0016 section 7): its own port at BFF + 2, the
 * HMAC over the raw body as the whole authentication, and a status map built
 * so that no forge switches the webhook off over our own configuration.
 */

const SECRET = 'hunter2-but-longer';

function trigger(name: string, overrides: Partial<Trigger> = {}): Trigger {
  return {
    name,
    enabled: true,
    agent: 'pi',
    prompt: 'Fix issue #{{issue.number}}.',
    overlap: 'skip',
    on: {
      type: 'webhook',
      source: 'github',
      event: 'issues',
      action: 'labeled',
    },
    ...overrides,
  };
}

const PAYLOAD = {
  action: 'labeled',
  issue: { number: 42 },
  label: { name: 'agent' },
  repository: { full_name: 'o/r' },
};

interface Harness {
  dirs: RunsDirs;
  queue: RunQueue;
  deps: WebhookServerDeps;
  url: string;
}

/** A listener over a real queue in a temp Store, its children never exiting. */
async function withListener(
  triggers: Trigger[],
  fn: (h: Harness) => Promise<void>,
  config: QueueConfig = DEFAULT_QUEUE_CONFIG
): Promise<void> {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'e-webhook-'));
  const launch: ChildLauncher = () => ({
    exited: new Promise<number>(() => {}),
    kill: () => {},
  });
  const dirs = runsDirs(store);
  const queue = new RunQueue({
    dirs,
    config,
    containerRunning: () => false,
    launch,
  });
  const deps: WebhookServerDeps = {
    envValue: name => (name === 'E_WEBHOOK_SECRET_GITHUB' ? SECRET : undefined),
    triggers: () => triggers,
    queue,
  };
  let server: Server | undefined;
  try {
    server = await startWebhookServer('127.0.0.1', 0, deps);
    const { port } = server.address() as AddressInfo;
    await fn({ dirs, queue, deps, url: `http://127.0.0.1:${port}` });
  } finally {
    server?.close();
    fs.rmSync(store, { recursive: true, force: true });
  }
}

function signedHeaders(
  body: string | Buffer,
  delivery = 'd-1',
  event = 'issues'
): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-github-event': event,
    'x-github-delivery': delivery,
    'x-hub-signature-256': signWebhookBody('github', SECRET, Buffer.from(body)),
  };
}

function post(
  url: string,
  body: string | Buffer,
  headers: Record<string, string>
): Promise<Response> {
  return fetch(`${url}/hooks/github`, { method: 'POST', headers, body });
}

test('webhookPortFor: the listener sits two above the BFF, past the embed proxy', () => {
  assert.equal(webhookPortFor(8080), 8082);
});

test('a valid signature over the raw body is accepted on loopback: 202, and the request is queued', () =>
  withListener([trigger('fix')], async ({ url, dirs }) => {
    const body = JSON.stringify(PAYLOAD);
    const res = await post(url, body, signedHeaders(body));
    assert.equal(res.status, 202);
    const reply = (await res.json()) as {
      accepted: { trigger: string; key: string; id: string }[];
    };
    assert.equal(reply.accepted.length, 1);
    assert.equal(reply.accepted[0].key, 'fix:d-1');
    assert.match(reply.accepted[0].id, /^trg-/);
    // Default two slots: claimed at once into the ledger.
    const [entry] = listLedger(dirs);
    assert.equal(entry.request?.key, 'fix:d-1');
    assert.equal(entry.request?.prompt, 'Fix issue #42.');
    assert.deepEqual(entry.request?.payload, PAYLOAD);
  }));

test('a wrong signature and an empty signature header both answer 401, on loopback too', () =>
  withListener([trigger('fix')], async ({ url, dirs }) => {
    const body = JSON.stringify(PAYLOAD);
    const wrong = {
      ...signedHeaders(body),
      'x-hub-signature-256': signWebhookBody(
        'github',
        'nope',
        Buffer.from(body)
      ),
    };
    assert.equal((await post(url, body, wrong)).status, 401);
    const empty = { ...signedHeaders(body), 'x-hub-signature-256': '' };
    assert.equal((await post(url, body, empty)).status, 401);
    const absent: Record<string, string> = { ...signedHeaders(body) };
    delete absent['x-hub-signature-256'];
    assert.equal((await post(url, body, absent)).status, 401);
    assert.deepEqual(listLedger(dirs), []);
    assert.deepEqual(listQueue(dirs), []);
  }));

test('status map: unknown source 404, wrong method 405, unknown path 404', () =>
  withListener([trigger('fix')], async ({ url }) => {
    const body = JSON.stringify(PAYLOAD);
    const gitlab = await fetch(`${url}/hooks/gitlab`, {
      method: 'POST',
      headers: signedHeaders(body),
      body,
    });
    assert.equal(gitlab.status, 404);
    const get = await fetch(`${url}/hooks/github`);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    const elsewhere = await fetch(`${url}/api/terminal/sessions`, {
      method: 'POST',
      headers: signedHeaders(body),
      body,
    });
    assert.equal(elsewhere.status, 404);
  }));

test('status map: malformed JSON and a missing event header answer 400, signature checked first', () =>
  withListener([trigger('fix')], async ({ url }) => {
    const broken = '{"action":';
    assert.equal((await post(url, broken, signedHeaders(broken))).status, 400);
    const body = JSON.stringify(PAYLOAD);
    const noEvent: Record<string, string> = { ...signedHeaders(body) };
    delete noEvent['x-github-event'];
    assert.equal((await post(url, body, noEvent)).status, 400);
    // Unsigned garbage is an authentication failure, not a parse error.
    assert.equal(
      (
        await post(url, broken, {
          ...signedHeaders(broken),
          'x-hub-signature-256': 'sha256=00',
        })
      ).status,
      401
    );
  }));

test('status map: no trigger matched answers 200, so GitLab-style disabling never trips on our config', () =>
  withListener(
    [
      trigger('fix', {
        on: { type: 'webhook', source: 'github', event: 'push' },
      }),
    ],
    async ({ url, dirs }) => {
      const body = JSON.stringify(PAYLOAD);
      const res = await post(url, body, signedHeaders(body));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { accepted: [], rejected: [] });
      assert.deepEqual(listQueue(dirs), []);
    }
  ));

test('status map: a trigger dropping the event (a value off its pattern) is 200 with its reason', () =>
  withListener(
    [trigger('fix', { dedup: 'pull_request.number' })],
    async ({ url }) => {
      const body = JSON.stringify(PAYLOAD);
      const res = await post(url, body, signedHeaders(body));
      assert.equal(res.status, 200);
      const reply = (await res.json()) as {
        rejected: { trigger: string; reason: string }[];
      };
      assert.equal(reply.rejected[0].trigger, 'fix');
      assert.match(reply.rejected[0].reason, /dedup path/);
    }
  ));

test('a redelivery while the first is still queued is deduped, and a fully deduped delivery answers 200', () =>
  withListener(
    [trigger('fix')],
    async ({ url, dirs }) => {
      const body = JSON.stringify(PAYLOAD);
      assert.equal((await post(url, body, signedHeaders(body))).status, 202);
      const again = await post(url, body, signedHeaders(body));
      assert.equal(again.status, 200);
      const reply = (await again.json()) as {
        rejected: { trigger: string; reason: string }[];
      };
      assert.match(reply.rejected[0].reason, /already pending/);
      assert.equal(listQueue(dirs).length, 1);
    },
    // No slot: the first request stays in queue/.
    { ...DEFAULT_QUEUE_CONFIG, slots: 0 }
  ));

test('a redelivery while the first run is live/ is accepted again: dedup is against queue/ only', () =>
  withListener(
    [trigger('fix', { overlap: 'allow' })],
    async ({ url, dirs }) => {
      const body = JSON.stringify(PAYLOAD);
      assert.equal((await post(url, body, signedHeaders(body))).status, 202);
      assert.equal(listLedger(dirs).length, 1);
      assert.equal(listQueue(dirs).length, 0);
      // The Redeliver button: same delivery id, the first run already claimed.
      assert.equal((await post(url, body, signedHeaders(body))).status, 202);
      assert.equal(listQueue(dirs).length, 1);
      assert.equal(listQueue(dirs)[0].key, 'fix:d-1');
    },
    { ...DEFAULT_QUEUE_CONFIG, slots: 1 }
  ));

test('overlap "skip" drops a delivery while the trigger owns a live run, answering 200', () =>
  withListener(
    [trigger('fix')],
    async ({ url, dirs }) => {
      const body = JSON.stringify(PAYLOAD);
      assert.equal(
        (await post(url, body, signedHeaders(body, 'd-1'))).status,
        202
      );
      const second = await post(url, body, signedHeaders(body, 'd-2'));
      assert.equal(second.status, 200);
      const reply = (await second.json()) as { rejected: { reason: string }[] };
      assert.match(reply.rejected[0].reason, /overlap: skip/);
      assert.equal(listQueue(dirs).length, 0);
    },
    { ...DEFAULT_QUEUE_CONFIG, slots: 1 }
  ));

test('three matching triggers against room for two: two accepted, the third rejected with its reason, 202', () =>
  withListener(
    [trigger('a'), trigger('b'), trigger('c')],
    async ({ url, dirs }) => {
      const body = JSON.stringify(PAYLOAD);
      const res = await post(url, body, signedHeaders(body));
      assert.equal(res.status, 202);
      const reply = (await res.json()) as {
        accepted: { trigger: string }[];
        rejected: { trigger: string; reason: string }[];
      };
      assert.deepEqual(
        reply.accepted.map(a => a.trigger),
        ['a', 'b']
      );
      assert.deepEqual(
        reply.rejected.map(r => r.trigger),
        ['c']
      );
      assert.match(reply.rejected[0].reason, /queue is full/);
      assert.equal(listQueue(dirs).length, 2);
    },
    { ...DEFAULT_QUEUE_CONFIG, slots: 0, maxLength: 2 }
  ));

test('queue full with nothing accepted answers 429', () =>
  withListener(
    [trigger('fix')],
    async ({ url }) => {
      const body = JSON.stringify(PAYLOAD);
      assert.equal(
        (await post(url, body, signedHeaders(body, 'd-1'))).status,
        202
      );
      const full = await post(url, body, signedHeaders(body, 'd-2'));
      assert.equal(full.status, 429);
      const reply = (await full.json()) as { rejected: { reason: string }[] };
      assert.match(reply.rejected[0].reason, /queue is full/);
    },
    { ...DEFAULT_QUEUE_CONFIG, slots: 0, maxLength: 1 }
  ));

/** A valid payload padded to about `bytes`. */
function paddedBody(bytes: number): string {
  const base = JSON.stringify({ ...PAYLOAD, pad: '' });
  return JSON.stringify({ ...PAYLOAD, pad: 'x'.repeat(bytes - base.length) });
}

test('a 6 MB payload answers 413; a 4 MB one is accepted', () =>
  withListener([trigger('fix')], async ({ url }) => {
    assert.equal(WEBHOOK_PAYLOAD_MAX_BYTES, 5 * 1024 * 1024);
    const big = paddedBody(6 * 1024 * 1024);
    assert.equal((await post(url, big, signedHeaders(big))).status, 413);
    const ok = paddedBody(4 * 1024 * 1024);
    assert.equal((await post(url, ok, signedHeaders(ok))).status, 202);
  }));

test('a delivery id with a newline is replaced by the entry ULID, and the delivery is still accepted', () =>
  withListener([trigger('fix')], async ({ deps, dirs }) => {
    // No HTTP client sends a raw newline in a header; the handler is the seam.
    const body = Buffer.from(JSON.stringify(PAYLOAD));
    const reply = handleWebhookDelivery(deps, {
      source: 'github',
      headers: signedHeaders(body, 'd-1\nE-Trigger: forged'),
      body,
    });
    assert.equal(reply.status, 202);
    const [entry] = listLedger(dirs);
    assert.equal(entry.request?.event?.id, entry.id.slice('trg-'.length));
    assert.equal(entry.request?.event?.source, 'github');
    assert.equal(entry.request?.event?.event, 'issues');
  }));

test('a secret removed from .env after start closes the source: 404, never an unauthenticated accept', () =>
  withListener([trigger('fix')], async ({ deps, dirs }) => {
    const body = Buffer.from(JSON.stringify(PAYLOAD));
    const reply = handleWebhookDelivery(
      { ...deps, envValue: () => undefined },
      { source: 'github', headers: signedHeaders(body), body }
    );
    assert.equal(reply.status, 404);
    assert.deepEqual(listLedger(dirs), []);
  }));

test('openWebhookListener: with no secret the port does not open, and the warning says where to put one', async () => {
  const listener = await openWebhookListener({
    host: '127.0.0.1',
    port: 0,
    envFile: '/s/.e/.env',
    envValue: () => undefined,
    triggers: () => [],
    queue: {
      enqueue: () => ({ status: 'full' }),
      liveTriggers: () => new Set(),
    },
  });
  assert.equal(listener.server, undefined);
  assert.match(
    (listener as { warning: string }).warning,
    /^Webhook listener disabled: .*E_WEBHOOK_SECRET_GITHUB.*\/s\/\.e\/\.env/
  );
});

test('openWebhookListener: without a run queue the port stays closed too', async () => {
  const listener = await openWebhookListener({
    host: '127.0.0.1',
    port: 0,
    envFile: '/s/.e/.env',
    envValue: () => SECRET,
    triggers: () => [],
    queue: undefined,
  });
  assert.equal(listener.server, undefined);
  assert.match(
    (listener as { warning: string }).warning,
    /^Webhook listener disabled: the run queue is disabled/
  );
});

test('openWebhookListener: with a secret it listens on the port it was given and names each source URL', () =>
  withListener([trigger('fix')], async ({ queue }) => {
    const listener = await openWebhookListener({
      host: '127.0.0.1',
      port: 0,
      envFile: '/s/.e/.env',
      envValue: name =>
        name === 'E_WEBHOOK_SECRET_GITHUB' ? SECRET : undefined,
      triggers: () => [trigger('fix')],
      queue,
    });
    assert.ok(listener.server);
    try {
      const { port } = listener.server.address() as AddressInfo;
      assert.deepEqual(listener.urls, [
        `http://127.0.0.1:${port}/hooks/github`,
      ]);
      const body = JSON.stringify(PAYLOAD);
      const res = await fetch(listener.urls[0], {
        method: 'POST',
        headers: signedHeaders(body),
        body,
      });
      assert.equal(res.status, 202);
    } finally {
      listener.server.close();
    }
  }));
