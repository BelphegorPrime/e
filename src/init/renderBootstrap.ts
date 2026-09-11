import Mustache from 'mustache';
import type { LocalRuntime } from './localRuntimes.js';

/**
 * Per-runtime wiring facts the bootstrap script needs: the compose service to
 * wait on, the health probe, and the OmniRoute provider registration body.
 */
interface RuntimeBootstrapFacts {
  service: string;
  healthUrl: string;
  provider: string;
  name: string;
  baseUrl: string;
}

const RUNTIME_FACTS: Readonly<Record<LocalRuntime, RuntimeBootstrapFacts>> = {
  llamacpp: {
    service: 'llama',
    healthUrl: 'http://localhost:9931/health',
    provider: 'llama-cpp',
    name: 'llama.cpp (local)',
    baseUrl: 'http://localhost:9931/v1',
  },
  ollama: {
    service: 'ollama',
    healthUrl: 'http://localhost:11434/api/version',
    provider: 'ollama',
    name: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
  },
  vllm: {
    service: 'vllm',
    healthUrl: 'http://localhost:8000/health',
    provider: 'vllm',
    name: 'vLLM (local)',
    baseUrl: 'http://localhost:8000/v1',
  },
};

/**
 * Bootstrap script template. It provisions OmniRoute only: waits for each
 * selected runtime to answer its health probe, then registers it as an
 * OmniRoute provider. Model downloads are deliberately out of scope - they
 * happen on demand through `e <runtime> download <model>`, so the one-shot
 * stack bring-up never blocks on a multi-GB model fetch.
 */
const TEMPLATE = `#!/bin/sh
set -eu

log() {
  printf '[bootstrap] %s\n' "$1"
}

log 'waiting for OmniRoute'
until curl -sf http://localhost:20128/healthz > /dev/null; do sleep 2; done
log 'OmniRoute ready; logging in'
login_headers=$(curl -sS -D - -o /dev/null -H 'Content-Type: application/json' \
  -d '{"password":"'"$INITIAL_PASSWORD"'"}' \
  http://localhost:20128/api/auth/login)
token=$(printf '%s\\n' "$login_headers" | sed -n 's/^set-cookie: auth_token=\\([^;]*\\).*/\\1/pI')
if test -z "$token"; then
  log 'OmniRoute rejected INITIAL_PASSWORD. Restore OMNIROUTE_INITIAL_PASSWORD from the original setup, or remove .e/volumes/omniroute-data to reset its local state.'
  exit 1
fi
{{#runtimes}}
log 'waiting for {{{name}}}'
until curl -sf {{{healthUrl}}} > /dev/null; do sleep 2; done
log '{{{name}}} ready; registering OmniRoute provider'
if ! curl -sf -H "Cookie: auth_token=$token" \
  http://localhost:20128/api/providers | grep -q '{{{name}}}'; then
  curl -sf -H "Cookie: auth_token=$token" -H 'Content-Type: application/json' \
    -d {{{providerBody}}} \
    http://localhost:20128/api/providers > /dev/null
  log 'provider registered'
else
  log 'provider already registered'
fi
{{/runtimes}}
log 'bootstrap complete'
`;

/** Quotes `value` as one POSIX shell word: `'…'` with an embedded `'` as `'\\''`. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The OmniRoute provider registration body for one runtime, JSON-encoded in
 * TypeScript and shell-quoted once, so a model id from `config.json` can never
 * break out of the script's JSON or its quoting.
 */
function providerBody(
  facts: RuntimeBootstrapFacts,
  defaultModel: string
): string {
  return shellSingleQuote(
    JSON.stringify({
      provider: facts.provider,
      apiKey: 'sk-no-key-required',
      name: facts.name,
      ...(defaultModel
        ? { defaultModel: `${facts.provider}/${defaultModel}` }
        : {}),
      providerSpecificData: { baseUrl: facts.baseUrl },
    })
  );
}

/**
 * Renders the one-shot script that registers the selected local runtimes as
 * OmniRoute providers. `defaultModel`, when given, is recorded as each
 * provider's initial default model id (model downloads stay manual via
 * `e <runtime> download <model>`). `INITIAL_PASSWORD` is still expanded by the
 * shell at run time into the login JSON; it comes from `.e/.env`, which `e
 * init` seeds as hex (a hand-set password must not contain `"` or `\\`).
 */
export function renderBootstrap(
  runtimes: readonly LocalRuntime[] = ['llamacpp'],
  defaultModel = ''
): string {
  return Mustache.render(TEMPLATE, {
    runtimes: runtimes.map(runtime => ({
      ...RUNTIME_FACTS[runtime],
      providerBody: providerBody(RUNTIME_FACTS[runtime], defaultModel),
    })),
  });
}
