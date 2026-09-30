import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalApiKeyError,
  RUN_KEY_PREFIX,
  createLocalApiKey,
  deleteLocalApiKey,
  listLocalApiKeys,
  mintLocalApiKey,
  needsLocalApiKey,
  providerTargetsLocalStack,
  signInLocalStack,
  staleRunKeys,
  upsertEnvValue,
} from './localApiKey.js';
import { fakeOmniRoute as statefulOmniRoute } from './omniRoute.testSupport.js';

const local = {
  baseUrl: 'http://localhost:20128/v1',
  apiKeyEnv: 'OPENAI_API_KEY',
};
const hosted = {
  baseUrl: 'https://api.anthropic.com',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
};

test('providerTargetsLocalStack: loopback on the OmniRoute port only', () => {
  assert.equal(providerTargetsLocalStack(local), true);
  assert.equal(
    providerTargetsLocalStack({ ...local, baseUrl: 'http://127.0.0.1:20128' }),
    true
  );
  assert.equal(providerTargetsLocalStack(hosted), false);
  assert.equal(
    providerTargetsLocalStack({
      ...local,
      baseUrl: 'http://localhost:9931/v1',
    }),
    false
  );
  assert.equal(providerTargetsLocalStack({ ...local, baseUrl: 'nope' }), false);
});

test('needsLocalApiKey: only a local-stack provider with a missing, initial or rejected key', () => {
  const base = {
    stackPresent: true,
    provider: local,
    stackPassword: 'initial-pw',
    accepted: true,
  };
  assert.equal(needsLocalApiKey({ ...base, configuredKey: '' }), true);
  assert.equal(
    needsLocalApiKey({ ...base, configuredKey: 'initial-pw' }),
    true
  );
  assert.equal(needsLocalApiKey({ ...base, configuredKey: 'sk-real' }), false);
  assert.equal(
    needsLocalApiKey({ ...base, configuredKey: 'sk-old', accepted: false }),
    true
  );
  // A hosted provider is never asked, even with a rejected or empty key.
  assert.equal(
    needsLocalApiKey({ ...base, provider: hosted, configuredKey: '' }),
    false
  );
  assert.equal(
    needsLocalApiKey({
      ...base,
      provider: hosted,
      configuredKey: 'x',
      accepted: false,
    }),
    false
  );
  // No stack, no prompt (nothing to log in to).
  assert.equal(
    needsLocalApiKey({ ...base, stackPresent: false, configuredKey: '' }),
    false
  );
  assert.equal(
    needsLocalApiKey({ ...base, provider: undefined, configuredKey: '' }),
    false
  );
});

test('upsertEnvValue: replaces only the named key, appends when absent, keeps $-patterns literal', () => {
  const env = 'ANTHROPIC_API_KEY=keep\nOPENAI_API_KEY=old\n';
  assert.equal(
    upsertEnvValue(env, 'OPENAI_API_KEY', 'sk-new'),
    'ANTHROPIC_API_KEY=keep\nOPENAI_API_KEY=sk-new\n'
  );
  assert.equal(
    upsertEnvValue(env, 'MY_GATEWAY_KEY', 'sk-gw'),
    'ANTHROPIC_API_KEY=keep\nOPENAI_API_KEY=old\nMY_GATEWAY_KEY=sk-gw\n'
  );
  assert.equal(upsertEnvValue('A=1', 'B', '2'), 'A=1\nB=2\n');
  assert.equal(upsertEnvValue('K=x\n', 'K', 'a$&b$1'), 'K=a$&b$1\n');
});

/** A fake OmniRoute: records requests, answers login and key creation. */
function fakeOmniRoute(opts: {
  password: string;
  keyStatus?: number;
  key?: unknown;
}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.endsWith('/api/auth/login')) {
      const { password } = JSON.parse(String(init?.body)) as {
        password: string;
      };
      if (password !== opts.password) {
        return new Response('{"error":"Invalid password"}', { status: 401 });
      }
      return new Response('{"success":true}', {
        status: 200,
        headers: { 'set-cookie': 'auth_token=jwt-123; Path=/; HttpOnly' },
      });
    }
    if (url.endsWith('/api/keys')) {
      return new Response(
        JSON.stringify({ key: opts.key ?? 'sk-new', id: '1' }),
        {
          status: opts.keyStatus ?? 201,
        }
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test('createLocalApiKey: signs in with the initial password and creates a key with the session cookie', async () => {
  const omni = fakeOmniRoute({ password: 'pw' });
  const key = await createLocalApiKey({
    baseUrl: 'http://127.0.0.1:20128',
    password: 'pw',
    name: 'e-cli',
    fetchImpl: omni.fetchImpl,
  });
  assert.equal(key, 'sk-new');
  assert.deepEqual(
    omni.calls.map(c => c.url),
    ['http://127.0.0.1:20128/api/auth/login', 'http://127.0.0.1:20128/api/keys']
  );
  const create = omni.calls[1].init;
  assert.equal(
    (create.headers as Record<string, string>).cookie,
    'auth_token=jwt-123'
  );
  assert.deepEqual(JSON.parse(String(create.body)), { name: 'e-cli' });
});

test('createLocalApiKey: a rejected password or a failed creation is a LocalApiKeyError (prompt fallback)', async () => {
  const wrongPw = fakeOmniRoute({ password: 'other' });
  await assert.rejects(
    createLocalApiKey({
      baseUrl: 'http://x',
      password: 'pw',
      name: 'e-cli',
      fetchImpl: wrongPw.fetchImpl,
    }),
    (err: unknown) =>
      err instanceof LocalApiKeyError &&
      /rejected OMNIROUTE_INITIAL_PASSWORD/.test(err.message)
  );
  assert.equal(wrongPw.calls.length, 1, 'no key creation without a session');

  const failing = fakeOmniRoute({ password: 'pw', keyStatus: 500 });
  await assert.rejects(
    createLocalApiKey({
      baseUrl: 'http://x',
      password: 'pw',
      name: 'e-cli',
      fetchImpl: failing.fetchImpl,
    }),
    LocalApiKeyError
  );
  const empty = fakeOmniRoute({ password: 'pw', key: '' });
  await assert.rejects(
    createLocalApiKey({
      baseUrl: 'http://x',
      password: 'pw',
      name: 'e-cli',
      fetchImpl: empty.fetchImpl,
    }),
    /returned no API key/
  );
});

const gateway = 'http://127.0.0.1:20128';

test('mintLocalApiKey: sends the name and expiry, returns id, key and expiry', async () => {
  const omni = statefulOmniRoute({ password: 'pw' });
  const session = await signInLocalStack({
    baseUrl: gateway,
    password: 'pw',
    fetchImpl: omni.fetchImpl,
  });
  const expiresAt = '2026-09-30T18:00:00.000Z';
  const minted = await mintLocalApiKey(session, {
    name: `${RUN_KEY_PREFIX}nightly`,
    expiresAt,
  });
  assert.deepEqual(minted, { id: 'minted-1', key: 'sk-run-1', expiresAt });
  const create = omni.calls.find(
    c => c.method === 'POST' && c.path === '/api/keys'
  );
  assert.deepEqual(JSON.parse(String(create?.init.body)), {
    name: 'e-run-nightly',
    expiresAt,
  });
  // No management scope is ever asked for: the run's key cannot mint keys.
  assert.equal('scopes' in JSON.parse(String(create?.init.body)), false);
});

test('mintLocalApiKey: an image that drops expiresAt on create gets it by PATCH', async () => {
  const omni = statefulOmniRoute({ password: 'pw', echoExpiry: false });
  const session = await signInLocalStack({
    baseUrl: gateway,
    password: 'pw',
    fetchImpl: omni.fetchImpl,
  });
  const expiresAt = '2026-09-30T18:00:00.000Z';
  const minted = await mintLocalApiKey(session, { name: 'e-run-x', expiresAt });
  assert.equal(minted.expiresAt, expiresAt);
  assert.equal(omni.keys[0].expiresAt, expiresAt);
  assert.ok(
    omni.calls.some(
      c => c.method === 'PATCH' && c.path === '/api/keys/minted-1'
    )
  );
});

test('mintLocalApiKey: a key whose expiry cannot be set is deleted, not handed out', async () => {
  const omni = statefulOmniRoute({
    password: 'pw',
    echoExpiry: false,
    fail: { 'PATCH /api/keys/minted-1': 500 },
  });
  const session = await signInLocalStack({
    baseUrl: gateway,
    password: 'pw',
    fetchImpl: omni.fetchImpl,
  });
  await assert.rejects(
    mintLocalApiKey(session, {
      name: 'e-run-x',
      expiresAt: '2026-09-30T18:00:00.000Z',
    }),
    (err: unknown) =>
      err instanceof LocalApiKeyError && /expiry/.test(err.message)
  );
  assert.deepEqual(omni.keys, []);
});

test('mintLocalApiKey: a create response without an id is refused: the key could never be deleted', async () => {
  const omni = statefulOmniRoute({ password: 'pw' });
  const session = await signInLocalStack({
    baseUrl: 'http://x',
    password: 'pw',
    fetchImpl: omni.fetchImpl,
  });
  const noId = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).endsWith('/api/keys')
      ? new Response('{"key":"sk-1"}', { status: 201 })
      : omni.fetchImpl(input, init)) as typeof fetch;
  await assert.rejects(
    mintLocalApiKey(
      { ...session, fetchImpl: noId },
      { name: 'e-run-x', expiresAt: '2026-09-30T18:00:00.000Z' }
    ),
    /no key id/
  );
});

test('listLocalApiKeys and deleteLocalApiKey: list the table, delete by id, a 404 is already gone', async () => {
  const omni = statefulOmniRoute({
    password: 'pw',
    keys: [
      {
        id: 'k1',
        name: 'e-run-old',
        key: 'sk-old-1234',
        createdAt: '2026-09-29T00:00:00.000Z',
        expiresAt: null,
      },
    ],
  });
  const session = await signInLocalStack({
    baseUrl: gateway,
    password: 'pw',
    fetchImpl: omni.fetchImpl,
  });
  assert.deepEqual(await listLocalApiKeys(session), [
    {
      id: 'k1',
      name: 'e-run-old',
      createdAt: '2026-09-29T00:00:00.000Z',
      expiresAt: null,
    },
  ]);
  await deleteLocalApiKey(session, 'k1');
  assert.deepEqual(omni.keys, []);
  await deleteLocalApiKey(session, 'k1');
  const failing = statefulOmniRoute({
    password: 'pw',
    fail: { 'DELETE /api/keys/k2': 500 },
  });
  await assert.rejects(
    deleteLocalApiKey({ ...session, fetchImpl: failing.fetchImpl }, 'k2'),
    /HTTP 500/
  );
});

test('signInLocalStack: a wrong password is a LocalApiKeyError', async () => {
  const omni = statefulOmniRoute({ password: 'pw' });
  await assert.rejects(
    signInLocalStack({
      baseUrl: gateway,
      password: 'nope',
      fetchImpl: omni.fetchImpl,
    }),
    (err: unknown) =>
      err instanceof LocalApiKeyError &&
      /rejected OMNIROUTE_INITIAL_PASSWORD/.test(err.message)
  );
});

test('staleRunKeys: e-run-* keys past their expiry, or without one and older than the cap', () => {
  const now = new Date('2026-09-30T12:00:00.000Z');
  const hour = 60 * 60 * 1000;
  const key = (
    id: string,
    name: string,
    createdAt: string,
    expiresAt: string | null = null
  ) => ({ id, name, createdAt, expiresAt });
  const keys = [
    key(
      'live',
      'e-run-a',
      '2026-09-30T11:00:00.000Z',
      '2026-09-30T15:00:00.000Z'
    ),
    // A run with a longer cap: old, but its expiry says it may still be live.
    key(
      'long',
      'e-run-e',
      '2026-09-30T06:00:00.000Z',
      '2026-09-30T13:00:00.000Z'
    ),
    key('old', 'e-run-b', '2026-09-30T08:00:00.000Z'),
    key('young', 'e-run-f', '2026-09-30T10:00:00.000Z'),
    key(
      'expired',
      'e-run-c',
      '2026-09-30T11:30:00.000Z',
      '2026-09-30T11:59:00.000Z'
    ),
    key('human', 'my laptop', '2026-01-01T00:00:00.000Z'),
    key('manual', 'e (claude)', '2026-01-01T00:00:00.000Z'),
    key('undated', 'e-run-d', 'not a date'),
  ];
  assert.deepEqual(
    staleRunKeys(keys, now, 3 * hour).map(k => k.id),
    ['old', 'expired']
  );
});
