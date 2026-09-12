import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalApiKeyError,
  createLocalApiKey,
  needsLocalApiKey,
  providerTargetsLocalStack,
  upsertEnvValue,
} from './localApiKey.js';

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
