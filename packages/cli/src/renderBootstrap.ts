import { MODELS } from './modelStatus';

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
token=$(curl -sf -D - -o /dev/null -H 'Content-Type: application/json' \
  -d '{"password":"'"$INITIAL_PASSWORD"'"}' \
  http://omniroute:20128/api/auth/login \
  | sed -n 's/^set-cookie: auth_token=\\([^;]*\\).*/\\1/pI')
test -n "$token"
log 'waiting for llama.cpp'
until curl -sf http://llama:9931/health > /dev/null; do sleep 2; done
log 'llama.cpp ready; synchronizing models'

for model in $models; do
  model_state=$(curl -sf http://llama:9931/models)
  if echo "$model_state" | grep -q '"id"[[:space:]]*:[[:space:]]*"'"$model"'"'; then
    if ! echo "$model_state" | grep -q '"id"[[:space:]]*:[[:space:]]*"'"$model"'".*"value"[[:space:]]*:[[:space:]]*"loaded"'; then
      log "loading model $model"
      curl -sf -X POST http://llama:9931/models/load \
        -H 'Content-Type: application/json' \
        -d '{"model":"'"$model"'"}' > /dev/null
    else
      log "model already loaded: $model"
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
