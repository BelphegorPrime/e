import { MODELS } from '../modelStatus.js';

/** Renders the one-shot script that provisions llama.cpp and OmniRoute for `models` (default: all). */
export function renderBootstrap(models: string[] = MODELS): string {
  const defaultModel = models[0];
  return `#!/bin/sh
set -eu

models='${models.join(' ')}'

log() {
  printf '[bootstrap] %s\n' "$1"
}

log 'waiting for OmniRoute'
until curl -sf http://omniroute:20128/healthz > /dev/null; do sleep 2; done
log 'OmniRoute ready; logging in'
login_headers=$(curl -sS -D - -o /dev/null -H 'Content-Type: application/json' \
  -d '{"password":"'"$INITIAL_PASSWORD"'"}' \
  http://omniroute:20128/api/auth/login)
token=$(printf '%s\\n' "$login_headers" | sed -n 's/^set-cookie: auth_token=\\([^;]*\\).*/\\1/pI')
if test -z "$token"; then
  log 'OmniRoute rejected INITIAL_PASSWORD. Restore OMNIROUTE_INITIAL_PASSWORD from the original setup, or remove .e/volumes/omniroute-data to reset its local state.'
  exit 1
fi
log 'waiting for llama.cpp'
until curl -sf http://llama:9931/health > /dev/null; do sleep 2; done
log 'llama.cpp ready; synchronizing models'

for model in $models; do
  repo=\${model%%:*}
  # llama.cpp canonicalizes the quant suffix of cached presets: a catalog id
  # whose quant carries a prefix (e.g. UD-) shows up with the canonical quant
  # once cached. Exact-quant matching therefore missed known models and
  # re-registered them, which llama.cpp answers with "model limit reached"
  # (HTTP 500 -> curl exit 22). Match by repo prefix and use llama's own id.
  model_state=$(curl -sf http://llama:9931/models)
  entry=$(printf '%s\\n' "$model_state" | sed 's/},{/}\\n{/g' | grep '"id"[[:space:]]*:[[:space:]]*"'$repo | head -1)
  if test -n "$entry"; then
    llama_id=$(printf '%s\\n' "$entry" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
    if printf '%s\\n' "$entry" | grep -q '"value"[[:space:]]*:[[:space:]]*"loaded"'; then
      log "model already loaded: $llama_id"
    else
      log "loading model $llama_id"
      curl -sf -X POST http://llama:9931/models/load \
        -H 'Content-Type: application/json' \
        -d '{"model":"'"$llama_id"'"}' > /dev/null
    fi
  else
    log "registering model $model"
    curl -sf -X POST http://llama:9931/models \
      -H 'Content-Type: application/json' \
      -d '{"model":"'"$model"'"}' > /dev/null
  fi
done

log 'synchronizing OmniRoute provider'
if ! curl -sf -H "Cookie: auth_token=$token" \
  http://omniroute:20128/api/providers | grep -q 'llama.cpp (local)'; then
  curl -sf -H "Cookie: auth_token=$token" -H 'Content-Type: application/json' \
    -d '{"provider":"llama-cpp","apiKey":"sk-no-key-required","name":"llama.cpp (local)","defaultModel":"llama-cpp/${defaultModel}","providerSpecificData":{"baseUrl":"http://llama:9931/v1"}}' \
    http://omniroute:20128/api/providers > /dev/null
  log 'OmniRoute provider registered'
else
  log 'OmniRoute provider already registered'
fi
log 'bootstrap complete'
`;
}
