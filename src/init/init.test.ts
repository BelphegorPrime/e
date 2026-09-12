import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  parseHarnessChoice,
  parseModelChoice,
  applyEnvValues,
  keysToPrompt,
  seedStackSecrets,
  OMNIROUTE_STACK_SECRETS,
} from './initPlan.js';
import { renderCompose } from './renderCompose.js';
import { renderBootstrap } from './renderBootstrap.js';
import { RUNTIME_CATALOGS, type LocalRuntime } from './localRuntimes.js';

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
// leaves everything else - filled keys, comments, unmatched keys - untouched.
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
  assert.match(
    compose,
    /egress:\n\s+build:\n\s+context: \.\/egress\n\s+image: e-egress/
  );
  assert.match(compose, /image: diegosouzapw\/omniroute:latest/);
  assert.match(compose, /image: ghcr\.io\/ggml-org\/llama\.cpp:server\n/);
  assert.match(compose, /LOCAL_HOSTNAMES: localhost/);
  assert.match(compose, /OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS: "true"/);
  assert.match(compose, /OMNIROUTE_BOOTSTRAPPED: "true"/);
  assert.match(compose, /bootstrap:/);
  assert.match(compose, /REDIS_URL: redis:\/\/localhost:6379/);
  assert.match(compose, /127\.0\.0\.1:20128:20128/);
  assert.match(compose, /- omniroute-data:\/app\/data/);
  assert.match(compose, /- llama-data:\/root\/\.cache/);
  assert.match(compose, /- redis-data:\/data/);
  assert.match(compose, /image: searxng\/searxng:latest/);
  assert.match(compose, /container_name: e-searxng/);
  assert.match(compose, /network_mode: "service:egress"/);
  assert.match(compose, /SEARXNG_BASE_URL: http:\/\/localhost:8080\//);
  assert.match(compose, /- searxng-data:\/etc\/searxng/);
  assert.match(compose, /searxng-data:\n {4}name: e-searxng-data/);
  assert.doesNotMatch(compose, /\.\/volumes\//);
  assert.match(compose, /LLAMA_ARG_HOST: "0\.0\.0\.0"/);
  assert.match(compose, /LLAMA_ARG_PORT: "9931"/);
  assert.match(compose, /LLAMA_ARG_CTX_SIZE: "32768"/);
  assert.match(compose, /LLAMA_ARG_N_PARALLEL: "1"/);
  assert.match(compose, /LLAMA_ARG_MODELS_MAX: "1"/);
  assert.match(compose, /- \.\/bootstrap\.sh:\/bootstrap\.sh:ro/);
  assert.match(
    compose,
    /^volumes:\n {2}omniroute-data:\n {4}name: omniroute-data\n {2}llama-data:\n {4}name: llama-data\n {2}redis-data:\n {4}name: redis-data$/m
  );
  // Only the selected runtime is provisioned: no Ollama or vLLM services.
  assert.doesNotMatch(compose, /\n {2}ollama:/);
  assert.doesNotMatch(compose, /\n {2}vllm:/);
});

test('renderCompose: bind-mounts both host-editable egress policy files into the egress container', () => {
  const compose = renderCompose('cpu', []);
  assert.match(
    compose,
    /- \.\/egress-blacklist:\/etc\/egress\.d\/dnsmasq\.blacklist:rw/
  );
  assert.match(
    compose,
    /- \.\/egress-iptables\.rules:\/etc\/egress\.d\/iptables\.rules:ro/
  );
  assert.match(compose, /- egress-logs:\/var\/log\/egress/);
});

test('renderCompose: adds the Ollama and vLLM containers when selected', () => {
  const compose = renderCompose('cpu', ['llamacpp', 'ollama', 'vllm']);
  assert.match(compose, /\n {2}llama:/);
  assert.match(compose, /\n {2}ollama:/);
  assert.match(compose, /image: ollama\/ollama:latest/);
  assert.match(compose, /127\.0\.0\.1:11434:11434/);
  assert.match(compose, /- ollama-data:\/root\/\.ollama/);
  assert.match(compose, /\n {2}vllm:/);
  assert.match(compose, /image: vllm\/vllm-openai:latest/);
  assert.match(compose, /127\.0\.0\.1:8000:8000/);
  assert.match(compose, /- vllm-data:\/root\/\.cache/);
  assert.match(
    compose,
    /^volumes:\n {2}omniroute-data:\n {4}name: omniroute-data\n {2}llama-data:\n {4}name: llama-data\n {2}ollama-data:\n {4}name: ollama-data\n {2}vllm-data:\n {4}name: vllm-data\n {2}redis-data:\n {4}name: redis-data$/m
  );
  // A runtime is still selected, so the provider-registration bootstrap exists.
  assert.match(compose, /bootstrap:/);
});

test('renderCompose: an Ollama-only stack renders no llama service', () => {
  const compose = renderCompose('cpu', ['ollama']);
  assert.doesNotMatch(compose, /\n {2}llama:/);
  assert.doesNotMatch(compose, /LLAMA_ARG_/);
  assert.match(compose, /\n {2}ollama:/);
  assert.match(compose, /image: ollama\/ollama:latest/);
  assert.match(compose, /bootstrap:/);
});

test('renderCompose: no runtime selection renders no bootstrap service and no runtime containers', () => {
  const compose = renderCompose('cpu', []);
  assert.doesNotMatch(compose, /\n {2}bootstrap:/);
  assert.doesNotMatch(compose, /\n {2}llama:/);
  assert.doesNotMatch(compose, /\n {2}ollama:/);
  assert.doesNotMatch(compose, /\n {2}vllm:/);
  assert.match(compose, /no local inference runtime selected/);
  // The gateway itself still renders.
  assert.match(compose, /image: diegosouzapw\/omniroute:latest/);
});

test('renderCompose: does not expose ports from services sharing the egress network namespace', () => {
  const compose = renderCompose('cpu');
  const redis = compose.slice(
    compose.indexOf('\n  redis:'),
    compose.indexOf('\nnetworks:')
  );

  assert.match(redis, /network_mode: "service:egress"/);
  assert.doesNotMatch(redis, /\n\s+expose:/);
});

test('renderCompose: binds OmniRoute to localhost only - no LAN exposure', () => {
  const compose = renderCompose('cpu');
  // The OmniRoute dashboard is a login surface; only the host itself may reach it.
  assert.doesNotMatch(compose, /\s- "20128:20128"/);
  assert.doesNotMatch(compose, /0\.0\.0\.0:20128/);

  // The compose stack stays isolated from untrusted run containers.
  assert.doesNotMatch(compose, /host\.docker\.internal/);
  assert.match(compose, /networks:\n\s+e-net:\n\s+name: e-net/);
  assert.doesNotMatch(compose, /omniroute-edge/);
  assert.match(compose, /egress:[\s\S]*?networks:\n\s+e-net:/);
  const namespaceSharers =
    compose.match(/network_mode: "service:egress"/g) ?? [];
  // egress shares with omniroute, redis, the bootstrap, and searxng (plus the
  // egress-adjacent runtimes when present); searxng rides the same namespace so
  // the run's web-search tools can reach it on loopback.
  assert.equal(namespaceSharers.length, 6);
});

test('renderCompose: no default secrets - every stack var must come from .env', () => {
  const compose = renderCompose('cpu');
  // Fallback defaults are gone; an unseeded stack fails closed instead of
  // shipping the well-known local-development credentials.
  assert.doesNotMatch(compose, /local-development/);
  assert.doesNotMatch(compose, /:-/);
  assert.match(compose, /JWT_SECRET: \$\{JWT_SECRET}/);
  assert.match(compose, /API_KEY_SECRET: \$\{API_KEY_SECRET}/);
  assert.match(compose, /INITIAL_PASSWORD: \$\{OMNIROUTE_INITIAL_PASSWORD}/g);
});

test('renderBootstrap: registers each selected runtime as an OmniRoute provider, without downloading models', () => {
  const script = renderBootstrap();
  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /OmniRoute rejected INITIAL_PASSWORD/);
  // Provider registration for the default llama.cpp runtime.
  assert.match(script, /waiting for llama\.cpp \(local\)/);
  assert.match(script, /until curl -sf http:\/\/localhost:9931\/health/);
  assert.match(script, /llama\.cpp \(local\)/);
  assert.match(script, /"provider":"llama-cpp"/);
  assert.match(script, /"apiKey":"sk-no-key-required"/);
  assert.match(script, /"baseUrl":"http:\/\/localhost:9931\/v1"/);
  // Model downloads are manual: the script must not touch llama's model API.
  assert.doesNotMatch(script, /POST http:\/\/localhost:9931\/models/);
  assert.doesNotMatch(script, /for model in \$models; do/);
  assert.doesNotMatch(script, /registering model/);
  assert.doesNotMatch(script, /loading model/);
  assert.doesNotMatch(script, /\/models\/load/);
});

test('renderBootstrap: a multi-runtime selection registers every provider', () => {
  const script = renderBootstrap(['llamacpp', 'ollama', 'vllm'], 'org/model');
  const healthUrls: Record<LocalRuntime, RegExp> = {
    llamacpp: /until curl -sf http:\/\/localhost:9931\/health/,
    ollama: /until curl -sf http:\/\/localhost:11434\/api\/version/,
    vllm: /until curl -sf http:\/\/localhost:8000\/health/,
  };
  for (const runtime of ['llamacpp', 'ollama', 'vllm'] as const) {
    assert.match(script, healthUrls[runtime]);
  }
  assert.match(script, /Ollama \(local\)/);
  assert.match(script, /vLLM \(local\)/);
  assert.match(script, /"provider":"ollama"/);
  assert.match(script, /"provider":"vllm"/);
  assert.match(script, /"baseUrl":"http:\/\/localhost:11434\/v1"/);
  assert.match(script, /"baseUrl":"http:\/\/localhost:8000\/v1"/);
  // The default model lands on every provider registration.
  assert.ok(script.includes('"defaultModel":"llama-cpp/org/model"'));
  assert.ok(script.includes('"defaultModel":"ollama/org/model"'));
  assert.ok(script.includes('"defaultModel":"vllm/org/model"'));
});

test('renderBootstrap: omits defaultModel when none is configured', () => {
  const script = renderBootstrap(['ollama']);
  assert.doesNotMatch(script, /"defaultModel":/);
});

test('renderBootstrap: a model id with quotes cannot break the script or its JSON', () => {
  const script = renderBootstrap(['ollama'], `it's "odd"/model`);
  // Still valid shell...
  const directory = mkdtempSync(join(tmpdir(), 'e-bootstrap-quote-'));
  try {
    const file = join(directory, 'bootstrap.sh');
    writeFileSync(file, script);
    execFileSync('sh', ['-n', file]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // ...and the JSON carries the id verbatim once the shell unquotes it.
  const dataArg = /-d ('(?:[^']|'\\'')*') /.exec(script);
  assert.ok(dataArg, 'provider body is a single-quoted shell word');
  const unquoted = dataArg[1].slice(1, -1).replace(/'\\''/g, "'");
  assert.equal(JSON.parse(unquoted).defaultModel, `ollama/it's "odd"/model`);
});

/**
 * The stubbed curl/sleep are `#!/bin/sh` scripts on PATH; spawning without a
 * shell on Windows resolves only `.exe`/`.com`, so the real curl would run.
 */
const needsShellShims = process.platform === 'win32' && 'sh shims on PATH';

/** Runs a rendered bootstrap against a stubbed curl, returning output or exit status. */
function runBootstrapProviderScript(
  runtimes: readonly LocalRuntime[],
  providersGetBody: string
): { output?: string; status?: number } {
  const directory = mkdtempSync(join(tmpdir(), 'e-bootstrap-test-'));
  const bootstrapPath = join(directory, 'bootstrap.sh');
  const curlPath = join(directory, 'curl');
  const sleepPath = join(directory, 'sleep');

  writeFileSync(bootstrapPath, renderBootstrap(runtimes), { mode: 0o755 });
  writeFileSync(
    curlPath,
    `#!/bin/sh
case "$*" in
  *localhost:20128/api/auth/login*)
    printf 'HTTP/1.1 200 OK\\r\\nset-cookie: auth_token=test-token; Path=/\\r\\n'
    ;;
  *localhost:20128/healthz*|*localhost:9931/health*|*localhost:11434/api/version*|*localhost:8000/health*)
    ;;
  *localhost:20128/api/providers*)
    printf '${providersGetBody}'
    ;;
  *)
    printf 'unexpected curl invocation: %s\\n' "$*" >&2
    exit 99
    ;;
esac
`,
    { mode: 0o755 }
  );
  writeFileSync(sleepPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(curlPath, 0o755);
  chmodSync(sleepPath, 0o755);

  try {
    return {
      output: execFileSync('/bin/sh', [bootstrapPath], {
        encoding: 'utf8',
        env: {
          ...process.env,
          INITIAL_PASSWORD: 'test-password',
          PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    return {
      status:
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        typeof error.status === 'number'
          ? error.status
          : undefined,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test(
  'renderBootstrap: registers a missing provider through the OmniRoute API',
  { skip: needsShellShims },
  () => {
    const result = runBootstrapProviderScript(['llamacpp', 'ollama'], '[]');
    assert.match(result.output ?? '', /provider registered/);
    assert.match(result.output ?? '', /bootstrap complete/);
  }
);

test(
  'renderBootstrap: skips a provider OmniRoute already knows',
  { skip: needsShellShims },
  () => {
    const result = runBootstrapProviderScript(
      ['llamacpp'],
      'llama.cpp (local)'
    );
    assert.match(result.output ?? '', /provider already registered/);
    assert.match(result.output ?? '', /bootstrap complete/);
  }
);

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

test('runtime model catalogs: each runtime offers its own models for the init selection', () => {
  // The union drives the wizard's model prompt; llama's catalog stays its own.
  const llamaIds = RUNTIME_CATALOGS.llamacpp.map(m => m.id);
  assert.ok(llamaIds.length > 0);
  assert.ok(RUNTIME_CATALOGS.ollama.every(m => m.id.includes(':')));
  assert.ok(RUNTIME_CATALOGS.vllm.every(m => m.id.includes('/')));
  // No id is offered by two runtimes.
  const all = [...llamaIds, ...RUNTIME_CATALOGS.ollama.map(m => m.id)];
  assert.equal(new Set(all).size, all.length);
});
