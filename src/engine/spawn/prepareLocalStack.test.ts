import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARNESSES } from '../../core/harness/index.js';
import {
  dockerComposePath,
  eBaseDir,
  envFilePath,
} from '../../core/store/paths.js';
import { OMNIROUTE_PORT } from '../../shared/constants.js';
import type { SpawnFacts } from './spawnPlan.js';
import {
  prepareLocalStack,
  type ApiKeyRequest,
  type LocalStackDeps,
} from './prepareLocalStack.js';

// The local-stack handshake: bring the store's OmniRoute stack up, then make
// sure the agent's provider holds a key that stack accepts. It lived inline in
// the `e spawn` action closure with no coverage at all; every path below used
// to be reachable only by running a real spawn against a real gateway.

const LOCAL_BASE_URL = `http://127.0.0.1:${OMNIROUTE_PORT}/v1`;
const localProvider = {
  name: 'omniroute',
  baseUrl: LOCAL_BASE_URL,
  apiKeyEnv: 'OPENAI_API_KEY',
  protocol: 'openai-chat' as const,
  model: 'auto',
};
const hostedProvider = {
  name: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  protocol: 'anthropic-messages' as const,
  model: 'auto',
};

/** A throwaway store root; `writeStack` adds the compose.yaml that makes one "present". */
async function withStore(fn: (root: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-local-stack-'));
  try {
    fs.mkdirSync(eBaseDir(root), { recursive: true });
    await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeStack(root: string): void {
  fs.writeFileSync(dockerComposePath(root), 'services: {}\n');
}

function writeStoreEnv(root: string, content: string): string {
  const file = envFilePath(root);
  fs.writeFileSync(file, content);
  return file;
}

function facts(overrides: Partial<SpawnFacts> = {}): SpawnFacts {
  return {
    root: '/root',
    agent: { name: 'demo', harness: 'claudeCode' },
    harness: HARNESSES.claudeCode,
    storeEnv: {},
    mcpServers: [],
    perRunSkills: [],
    bakedSkills: [],
    prompt: 'do it',
    localStackPresent: false,
    rebuild: false,
    env: [],
    worktreesDir: '/tmp/e-worktrees',
    siblingArtifacts: [],
    maxSiblings: 3,
    localRuntimes: [],
    ...overrides,
  };
}

type ComposeCall = [string, string | undefined, boolean | undefined];

/** Records every composeUp and refuses to be asked for a key unless told to. */
function deps(
  overrides: Partial<LocalStackDeps> = {}
): LocalStackDeps & { composeCalls: ComposeCall[] } {
  const composeCalls: ComposeCall[] = [];
  return {
    composeCalls,
    runtime: {
      composeUp: (file, envFile, wait) =>
        void composeCalls.push([file, envFile, wait]),
    },
    askForKey: () => assert.fail('the operator must not be asked for a key'),
    ...overrides,
  };
}

/** A fetch that answers OmniRoute's two endpoints from a script. */
function omniRoute(script: {
  models?: number;
  login?: { status: number; token?: string };
  keys?: { status: number; body?: unknown };
}): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/v1/models')) {
      return new Response('', { status: script.models ?? 200 });
    }
    if (url.endsWith('/api/auth/login')) {
      const { status, token } = script.login ?? { status: 401 };
      const headers = token
        ? { 'set-cookie': `auth_token=${token}; Path=/` }
        : undefined;
      return new Response('', { status, headers });
    }
    if (url.endsWith('/api/keys')) {
      const { status, body } = script.keys ?? { status: 500 };
      return new Response(JSON.stringify(body ?? {}), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return assert.fail(`unexpected request to ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

test('no local stack: nothing is brought up and the facts pass through', async () => {
  const before = facts({ agent: { name: 'demo', harness: 'claudeCode' } });
  const d = deps();
  const after = await prepareLocalStack(before, d);
  assert.deepEqual(d.composeCalls, []);
  assert.equal(after, before);
});

test('a present stack is brought up with its own compose file and .e/.env', async () => {
  await withStore(async root => {
    writeStack(root);
    const envFile = writeStoreEnv(root, '');
    const d = deps();
    await prepareLocalStack(
      facts({ root, localStackPresent: true, localRuntimes: ['llamacpp'] }),
      d
    );
    // The stack interpolates from `.e/.env`, so it is passed explicitly; a
    // selected local runtime means there is a bootstrap service to wait for.
    assert.deepEqual(d.composeCalls, [
      [dockerComposePath(root), envFile, true],
    ]);
  });
});

test('a stack with no local runtime renders no bootstrap service to wait for', async () => {
  await withStore(async root => {
    writeStack(root);
    const d = deps();
    await prepareLocalStack(facts({ root, localStackPresent: true }), d);
    assert.equal(d.composeCalls[0][2], false);
    // No `.e/.env` on disk: compose gets no env-file rather than a bad path.
    assert.equal(d.composeCalls[0][1], undefined);
  });
});

test('an agent with no provider is never asked for a key', async () => {
  await withStore(async root => {
    writeStack(root);
    const before = facts({ root, localStackPresent: true });
    const after = await prepareLocalStack(before, deps());
    assert.equal(after, before);
  });
});

test('a hosted provider is never checked and never overwritten', async () => {
  await withStore(async root => {
    writeStack(root);
    const { fetchImpl, urls } = omniRoute({});
    const before = facts({
      root,
      localStackPresent: true,
      agent: { name: 'demo', harness: 'claudeCode', provider: hostedProvider },
      storeEnv: { ANTHROPIC_API_KEY: 'sk-ant-real' },
    });
    const after = await prepareLocalStack(before, deps({ fetchImpl }));
    assert.deepEqual(urls, []);
    assert.equal(after, before);
  });
});

test('a working local key is left alone after one /v1/models check', async () => {
  await withStore(async root => {
    writeStack(root);
    const { fetchImpl, urls } = omniRoute({ models: 200 });
    const before = facts({
      root,
      localStackPresent: true,
      agent: { name: 'demo', harness: 'claudeCode', provider: localProvider },
      storeEnv: { OPENAI_API_KEY: 'sk-works' },
    });
    const after = await prepareLocalStack(before, deps({ fetchImpl }));
    assert.equal(urls.length, 1);
    assert.match(urls[0], /\/v1\/models$/);
    assert.equal(after, before);
  });
});

test('an unreachable gateway counts as accepting: a good key survives a blip', async () => {
  await withStore(async root => {
    writeStack(root);
    const fetchImpl = (() => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const before = facts({
      root,
      localStackPresent: true,
      agent: { name: 'demo', harness: 'claudeCode', provider: localProvider },
      storeEnv: { OPENAI_API_KEY: 'sk-works' },
    });
    const after = await prepareLocalStack(before, deps({ fetchImpl }));
    assert.equal(after, before);
  });
});

test('a missing key is created through OmniRoute and saved under the provider var', async () => {
  await withStore(async root => {
    writeStack(root);
    const envFile = writeStoreEnv(
      root,
      'OMNIROUTE_INITIAL_PASSWORD=pw\nANTHROPIC_API_KEY=sk-other\n'
    );
    const { fetchImpl, urls } = omniRoute({
      login: { status: 200, token: 'tok' },
      keys: { status: 200, body: { key: 'sk-new' } },
    });
    const before = facts({
      root,
      localStackPresent: true,
      baseEnvFile: envFile,
      agent: { name: 'demo', harness: 'claudeCode', provider: localProvider },
      storeEnv: { OMNIROUTE_INITIAL_PASSWORD: 'pw' },
    });
    const after = await prepareLocalStack(before, deps({ fetchImpl }));

    // No round trip for a key that was never configured - straight to creating one.
    assert.deepEqual(
      urls.map(u => new URL(u).pathname),
      ['/api/auth/login', '/api/keys']
    );
    assert.equal(after.storeEnv.OPENAI_API_KEY, 'sk-new');
    // The gathered facts are readonly: the new key is on a new value.
    assert.equal(before.storeEnv.OPENAI_API_KEY, undefined);
    // Only the provider's own variable is touched; another agent's key stays.
    const written = fs.readFileSync(envFile, 'utf8');
    assert.match(written, /^OPENAI_API_KEY=sk-new$/m);
    assert.match(written, /^ANTHROPIC_API_KEY=sk-other$/m);
    assert.match(written, /^OMNIROUTE_INITIAL_PASSWORD=pw$/m);
  });
});

test('a key still set to the stack password counts as unconfigured', async () => {
  await withStore(async root => {
    writeStack(root);
    const envFile = writeStoreEnv(root, 'OPENAI_API_KEY=pw\n');
    const { fetchImpl, urls } = omniRoute({
      login: { status: 200, token: 'tok' },
      keys: { status: 200, body: { key: 'sk-new' } },
    });
    const after = await prepareLocalStack(
      facts({
        root,
        localStackPresent: true,
        baseEnvFile: envFile,
        agent: { name: 'demo', harness: 'claudeCode', provider: localProvider },
        storeEnv: { OPENAI_API_KEY: 'pw', OMNIROUTE_INITIAL_PASSWORD: 'pw' },
      }),
      deps({ fetchImpl })
    );
    // The initial password is not an endpoint key, so it is not worth probing.
    assert.equal(
      urls.some(u => u.endsWith('/v1/models')),
      false
    );
    assert.equal(after.storeEnv.OPENAI_API_KEY, 'sk-new');
  });
});

test('a key OmniRoute rejects with 401 is replaced', async () => {
  await withStore(async root => {
    writeStack(root);
    const envFile = writeStoreEnv(root, 'OPENAI_API_KEY=sk-stale\n');
    const { fetchImpl, urls } = omniRoute({
      models: 401,
      login: { status: 200, token: 'tok' },
      keys: { status: 200, body: { key: 'sk-fresh' } },
    });
    const after = await prepareLocalStack(
      facts({
        root,
        localStackPresent: true,
        baseEnvFile: envFile,
        agent: { name: 'demo', harness: 'claudeCode', provider: localProvider },
        storeEnv: {
          OPENAI_API_KEY: 'sk-stale',
          OMNIROUTE_INITIAL_PASSWORD: 'pw',
        },
      }),
      deps({ fetchImpl })
    );
    assert.deepEqual(
      urls.map(u => new URL(u).pathname),
      ['/v1/models', '/api/auth/login', '/api/keys']
    );
    assert.equal(after.storeEnv.OPENAI_API_KEY, 'sk-fresh');
    assert.match(
      fs.readFileSync(envFile, 'utf8'),
      /^OPENAI_API_KEY=sk-fresh$/m
    );
  });
});

test('a rejected stack password falls back to asking, and that answer is saved too', async () => {
  await withStore(async root => {
    writeStack(root);
    const envFile = writeStoreEnv(root, '');
    const { fetchImpl } = omniRoute({ login: { status: 401 } });
    const asked: ApiKeyRequest[] = [];
    const after = await prepareLocalStack(
      facts({
        root,
        localStackPresent: true,
        baseEnvFile: envFile,
        agent: { name: 'demo', harness: 'claudeCode', provider: localProvider },
        storeEnv: { OMNIROUTE_INITIAL_PASSWORD: 'wrong-pw' },
      }),
      deps({
        fetchImpl,
        askForKey: request => {
          asked.push(request);
          return Promise.resolve('sk-typed');
        },
      })
    );
    assert.deepEqual(asked, [
      {
        apiKeyEnv: 'OPENAI_API_KEY',
        initialPassword: 'wrong-pw',
        agentName: 'demo',
      },
    ]);
    assert.equal(after.storeEnv.OPENAI_API_KEY, 'sk-typed');
    assert.match(
      fs.readFileSync(envFile, 'utf8'),
      /^OPENAI_API_KEY=sk-typed$/m
    );
  });
});

test('no stack password at all: the user is asked straight away', async () => {
  await withStore(async root => {
    writeStack(root);
    const envFile = writeStoreEnv(root, '');
    const { fetchImpl, urls } = omniRoute({});
    const after = await prepareLocalStack(
      facts({
        root,
        localStackPresent: true,
        baseEnvFile: envFile,
        agent: { name: 'demo', harness: 'claudeCode', provider: localProvider },
      }),
      deps({ fetchImpl, askForKey: () => Promise.resolve('sk-typed') })
    );
    assert.deepEqual(urls, []);
    assert.equal(after.storeEnv.OPENAI_API_KEY, 'sk-typed');
  });
});

test('without a base env-file on disk the key is written to the store .e/.env', async () => {
  await withStore(async root => {
    writeStack(root);
    const after = await prepareLocalStack(
      facts({
        root,
        localStackPresent: true,
        agent: { name: 'demo', harness: 'claudeCode', provider: localProvider },
      }),
      deps({ askForKey: () => Promise.resolve('sk-typed') })
    );
    assert.equal(after.storeEnv.OPENAI_API_KEY, 'sk-typed');
    assert.equal(
      fs.readFileSync(envFilePath(root), 'utf8'),
      'OPENAI_API_KEY=sk-typed\n'
    );
  });
});
