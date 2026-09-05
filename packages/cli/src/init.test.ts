import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseHarnessChoice,
  parseModelChoice,
  applyEnvValues,
  keysToPrompt,
  prepareComposeDataDir,
  seedStackSecrets,
  OMNIROUTE_STACK_SECRETS,
} from './init';
import { renderCompose } from './renderCompose';
import { renderBootstrap } from './renderBootstrap';
import { MODEL_CATALOG } from './modelStatus';

// parseHarnessChoice is pure: it maps a prompt answer to a harness name, taking
// the fallback for a blank answer and undefined for anything unrecognized.
const NAMES = ['pi', 'claudeCode', 'codex', 'opencode'];

test('parseHarnessChoice: a blank answer takes the fallback', () => {
  assert.equal(parseHarnessChoice('', NAMES, 'pi'), 'pi');
  assert.equal(parseHarnessChoice('   ', NAMES, 'pi'), 'pi');
});

test('parseHarnessChoice: an exact name (trimmed) selects it', () => {
  assert.equal(parseHarnessChoice('codex', NAMES, 'pi'), 'codex');
  assert.equal(parseHarnessChoice('  opencode  ', NAMES, 'pi'), 'opencode');
});

test('parseHarnessChoice: a 1-based index selects that harness', () => {
  assert.equal(parseHarnessChoice('1', NAMES, 'pi'), 'pi');
  assert.equal(parseHarnessChoice('3', NAMES, 'pi'), 'codex');
});

test('parseHarnessChoice: an out-of-range index or unknown name is unrecognized', () => {
  assert.equal(parseHarnessChoice('0', NAMES, 'pi'), undefined);
  assert.equal(parseHarnessChoice('99', NAMES, 'pi'), undefined);
  assert.equal(parseHarnessChoice('nope', NAMES, 'pi'), undefined);
});

// parseModelChoice is pure: it maps a multi-select prompt answer to a set of
// catalog model ids, taking the fallback for a blank answer.
const CATALOG = [
  { id: 'org/model-a', sizeBytes: 1 },
  { id: 'org/model-b', sizeBytes: 2 },
  { id: 'org/model-c', sizeBytes: 3 },
];

test('parseModelChoice: a blank answer takes the fallback', () => {
  assert.deepEqual(parseModelChoice('', CATALOG, ['org/model-b']), [
    'org/model-b',
  ]);
  assert.deepEqual(parseModelChoice('   ', CATALOG, []), []);
});

test('parseModelChoice: "all" and "none" select every/no model', () => {
  assert.deepEqual(parseModelChoice('all', CATALOG, []), [
    'org/model-a',
    'org/model-b',
    'org/model-c',
  ]);
  assert.deepEqual(parseModelChoice('ALL', CATALOG, []), [
    'org/model-a',
    'org/model-b',
    'org/model-c',
  ]);
  assert.deepEqual(parseModelChoice('none', CATALOG, ['org/model-a']), []);
});

test('parseModelChoice: comma-separated 1-based indices select those models, deduplicated', () => {
  assert.deepEqual(parseModelChoice('1,3', CATALOG, []), [
    'org/model-a',
    'org/model-c',
  ]);
  assert.deepEqual(parseModelChoice('2, 2, 1', CATALOG, []), [
    'org/model-b',
    'org/model-a',
  ]);
});

test('parseModelChoice: an out-of-range index or unknown token is unrecognized', () => {
  assert.equal(parseModelChoice('0', CATALOG, []), undefined);
  assert.equal(parseModelChoice('99', CATALOG, []), undefined);
  assert.equal(parseModelChoice('nope', CATALOG, []), undefined);
  assert.equal(parseModelChoice('1,nope', CATALOG, []), undefined);
});

// applyEnvValues is pure: it fills blank `KEY=` lines with collected values and
// leaves everything else — filled keys, comments, unmatched keys — untouched.
test('applyEnvValues: fills a blank key with its collected value', () => {
  const out = applyEnvValues('ANTHROPIC_API_KEY=\nOPENAI_API_KEY=\n', {
    ANTHROPIC_API_KEY: 'sk-abc',
  });
  assert.equal(out, 'ANTHROPIC_API_KEY=sk-abc\nOPENAI_API_KEY=\n');
});

test('applyEnvValues: never clobbers an already-filled key', () => {
  const out = applyEnvValues('ANTHROPIC_API_KEY=existing\n', {
    ANTHROPIC_API_KEY: 'sk-new',
  });
  assert.equal(out, 'ANTHROPIC_API_KEY=existing\n');
});

test('applyEnvValues: an empty collected value leaves the blank line as-is', () => {
  const out = applyEnvValues('OPENAI_API_KEY=\n', { OPENAI_API_KEY: '' });
  assert.equal(out, 'OPENAI_API_KEY=\n');
});

test('applyEnvValues: comments and unrelated lines are preserved', () => {
  const input = '# a comment\n\nANTHROPIC_API_KEY=\n# --- pi ---\n';
  const out = applyEnvValues(input, { ANTHROPIC_API_KEY: 'sk-abc' });
  assert.equal(out, '# a comment\n\nANTHROPIC_API_KEY=sk-abc\n# --- pi ---\n');
});

test('prepareOmnirouteDataDir: creates container-writable local volume directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e-init-'));
  try {
    prepareComposeDataDir(root);
    for (const name of ['omniroute-data', 'llama-data', 'redis-data']) {
      const directory = path.join(root, '.e', 'volumes', name);
      assert.ok(fs.statSync(directory).isDirectory());
      assert.equal(fs.statSync(directory).mode & 0o777, 0o777);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// keysToPrompt is pure: it drops keys already filled in the existing `.env`.
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

test('keysToPrompt: no existing .env prompts for every required key', () => {
  assert.deepEqual(keysToPrompt(KEYS, undefined), KEYS);
});

test('keysToPrompt: a filled key is skipped', () => {
  assert.deepEqual(
    keysToPrompt(KEYS, { ANTHROPIC_API_KEY: 'sk-abc', OPENAI_API_KEY: '' }),
    ['OPENAI_API_KEY']
  );
});

test('keysToPrompt: a blank (KEY=) or whitespace-only key still prompts', () => {
  assert.deepEqual(
    keysToPrompt(KEYS, { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '   ' }),
    KEYS
  );
});

test('keysToPrompt: all keys filled leaves nothing to prompt', () => {
  assert.deepEqual(
    keysToPrompt(KEYS, {
      ANTHROPIC_API_KEY: 'sk-abc',
      OPENAI_API_KEY: 'sk-def',
    }),
    []
  );
});

test('seedStackSecrets: fills unset stack secrets with fresh random values', () => {
  const seeded = seedStackSecrets({});
  for (const key of OMNIROUTE_STACK_SECRETS) {
    assert.ok(seeded[key], `${key} should be generated on an empty store env`);
  }
  // Random hex: the password is 16 bytes, the secrets 32 bytes.
  assert.match(seeded.OMNIROUTE_INITIAL_PASSWORD, /^[0-9a-f]{32}$/);
  assert.match(seeded.JWT_SECRET, /^[0-9a-f]{64}$/);
  assert.match(seeded.API_KEY_SECRET, /^[0-9a-f]{64}$/);
  // Each call draws fresh bytes: two seeds never produce the same value.
  assert.notEqual(
    seedStackSecrets({}).OMNIROUTE_INITIAL_PASSWORD,
    seeded.OMNIROUTE_INITIAL_PASSWORD
  );
});

test('seedStackSecrets: never rotates a value already set (re-init preserves)', () => {
  const existing = {
    OMNIROUTE_INITIAL_PASSWORD: 'user-picked',
    JWT_SECRET: 'kept',
  };
  const seeded = seedStackSecrets(existing);
  assert.equal(seeded.OMNIROUTE_INITIAL_PASSWORD, 'user-picked');
  assert.equal(seeded.JWT_SECRET, 'kept');
  // Unset keys still get generated.
  assert.match(seeded.API_KEY_SECRET, /^[0-9a-f]{64}$/);
});

test('seedStackSecrets: a blank key counts as absent and is generated', () => {
  const seeded = seedStackSecrets({ OMNIROUTE_INITIAL_PASSWORD: '' });
  assert.match(seeded.OMNIROUTE_INITIAL_PASSWORD, /^[0-9a-f]{32}$/);
});

test('renderCompose: starts OmniRoute, llama.cpp, and Redis with local networking', () => {
  const compose = renderCompose('cpu');
  assert.match(compose, /image: diegosouzapw\/omniroute:latest/);
  assert.match(compose, /image: ghcr\.io\/ggml-org\/llama\.cpp:server\n/);
  assert.match(compose, /LOCAL_HOSTNAMES: llama/);
  assert.match(compose, /OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS: "true"/);
  assert.match(compose, /OMNIROUTE_BOOTSTRAPPED: "true"/);
  assert.match(compose, /bootstrap:/);
  assert.match(compose, /REDIS_URL: redis:\/\/redis:6379/);
  assert.match(compose, /127\.0\.0\.1:20128:20128/);
  assert.match(compose, /- \.\/volumes\/omniroute-data:\/app\/data/);
  assert.match(compose, /- \.\/volumes\/llama-data:\/root\/\.cache/);
  assert.match(compose, /- \.\/volumes\/redis-data:\/data/);
  assert.match(compose, /LLAMA_ARG_HOST: "0\.0\.0\.0"/);
  assert.match(compose, /LLAMA_ARG_PORT: "9931"/);
  assert.match(compose, /LLAMA_ARG_CTX_SIZE: "65536"/);
  assert.match(compose, /LLAMA_ARG_N_PARALLEL: "2"/);
  assert.match(compose, /- \.\/bootstrap\.sh:\/bootstrap\.sh:ro/);
  assert.doesNotMatch(compose, /^volumes:\n/m);
});

test('renderCompose: binds OmniRoute to localhost only — no LAN exposure', () => {
  const compose = renderCompose('cpu');
  // The OmniRoute dashboard is a login surface; only the host itself may reach it.
  assert.doesNotMatch(compose, /\s- "20128:20128"/);
  assert.doesNotMatch(compose, /0\.0\.0\.0:20128/);
});

test('renderCompose: no default secrets — every stack var must come from .env', () => {
  const compose = renderCompose('cpu');
  // Fallback defaults are gone; an unseeded stack fails closed instead of
  // shipping the well-known local-development credentials.
  assert.doesNotMatch(compose, /local-development/);
  assert.doesNotMatch(compose, /:-/);
  assert.match(compose, /JWT_SECRET: \$\{JWT_SECRET}/);
  assert.match(compose, /API_KEY_SECRET: \$\{API_KEY_SECRET}/);
  assert.match(compose, /INITIAL_PASSWORD: \$\{OMNIROUTE_INITIAL_PASSWORD}/g);
});

test('renderBootstrap: downloads and registers the configured llama.cpp model', () => {
  const script = renderBootstrap();
  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /POST http:\/\/llama:9931\/models/);
  assert.match(script, /for model in \$models; do/);
  assert.match(script, /"id"\[\[:space:\]\]\*:\[\[:space:\]\]\*"/);
  assert.match(
    script,
    /"id".*"value"\[\[:space:\]\]\*:\[\[:space:\]\]\*"loaded"/
  );
  assert.match(
    script,
    /models='unsloth\/Qwen3\.8-Flash-Next-GGUF:Q4_K_M ornith-ai\/Ornith-1\.5-35B-A3B-GGUF:Q4_K_M'/
  );
  assert.doesNotMatch(script, /until curl -sf http:\/\/llama:9931\/models/);
  assert.match(script, /unsloth\/Qwen3\.8-Flash-Next-GGUF:Q4_K_M/);
  assert.match(script, /ornith-ai\/Ornith-1\.5-35B-A3B-GGUF:Q4_K_M/);
  assert.match(script, /llama\.cpp \(local\)/);
  assert.match(script, /"provider":"llama-cpp"/);
  assert.match(script, /"apiKey":"sk-no-key-required"/);
});

test('renderBootstrap: a custom model selection only provisions those models, with the first as default', () => {
  const [excluded, included] = MODEL_CATALOG;
  const script = renderBootstrap([included.id]);
  assert.ok(script.includes(`models='${included.id}'`));
  assert.ok(!script.includes(excluded.id));
  assert.ok(script.includes(`"defaultModel":"llama-cpp/${included.id}"`));
});

test('renderCompose: picks the CUDA image and reserves an nvidia GPU for the nvidia vendor', () => {
  const compose = renderCompose('nvidia');
  assert.match(compose, /image: ghcr\.io\/ggml-org\/llama\.cpp:server-cuda/);
  assert.match(compose, /driver: nvidia/);
  assert.match(compose, /capabilities: \[gpu\]/);
});

test('renderCompose: picks the ROCm image and passes through /dev/kfd for the amd vendor', () => {
  const compose = renderCompose('amd');
  assert.match(compose, /image: ghcr\.io\/ggml-org\/llama\.cpp:server-rocm/);
  assert.match(compose, /\/dev\/kfd/);
});

test('renderCompose: picks the SYCL image and passes through /dev/dri for the intel vendor', () => {
  const compose = renderCompose('intel');
  assert.match(compose, /image: ghcr\.io\/ggml-org\/llama\.cpp:server-intel/);
  assert.match(compose, /\/dev\/dri/);
});
