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
log 'waiting for llama.cpp'
until curl -sf http://localhost:9931/health > /dev/null; do sleep 2; done
log 'llama.cpp ready; synchronizing models'

for model in $models; do
  repo=\${model%%:*}
  # llama.cpp canonicalizes the quant suffix of cached presets: a catalog id
  # whose quant carries a prefix (e.g. UD-) shows up with the canonical quant
  # once cached. Exact-quant matching therefore missed known models and
  # re-registered them, which llama.cpp answers with "model limit reached"
  # (HTTP 500 -> curl exit 22). Match by repo prefix and use llama's own id.
  model_state=$(curl -sf http://localhost:9931/models)
  entry=$(printf '%s\\n' "$model_state" | sed 's/},{/}\\n{/g' | grep '"id"[[:space:]]*:[[:space:]]*"'$repo | head -1)
  if test -n "$entry"; then
    llama_id=$(printf '%s\\n' "$entry" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
    if printf '%s\\n' "$entry" | grep -q '"value"[[:space:]]*:[[:space:]]*"loaded"'; then
      log "model already loaded: $llama_id"
    else
      log "loading model $llama_id"
      # llama may return HTTP 500 "model limit reached" while
      # it evicts the previous model and continues this load asynchronously.
      # Accept only that known response; all other transport/HTTP errors fail.
      if ! load_response=$(curl -sS -X POST http://localhost:9931/models/load \
        -H 'Content-Type: application/json' \
        -d '{"model":"'"$llama_id"'"}' \
        -w '\\n%{http_code}'); then
        log "llama.cpp load request failed: $llama_id"
        exit 1
      fi
      load_status=$(printf '%s\\n' "$load_response" | tail -n 1)
      load_body=$(printf '%s\\n' "$load_response" | sed '$d')
      case "$load_status" in
        2??) ;;
        500)
          if ! printf '%s\\n' "$load_body" | grep -q '"message"[[:space:]]*:[[:space:]]*"model limit reached, try again later"'; then
            log "llama.cpp rejected model load (HTTP $load_status): $llama_id"
            exit 1
          fi
          log "model load continues after capacity eviction: $llama_id"
          ;;
        *)
          log "llama.cpp rejected model load (HTTP $load_status): $llama_id"
          exit 1
          ;;
      esac

      attempts=0
      until model_state=$(curl -sf http://localhost:9931/models) && entry=$(printf '%s\\n' "$model_state" | sed 's/},{/}\\n{/g' | grep '"id"[[:space:]]*:[[:space:]]*"'$repo | head -1) && printf '%s\\n' "$entry" | grep -q '"value"[[:space:]]*:[[:space:]]*"loaded"'; do
        if printf '%s\\n' "$entry" | grep -q '"value"[[:space:]]*:[[:space:]]*"failed"'; then
          log "llama.cpp failed loading model: $llama_id"
          exit 1
        fi
        attempts=$((attempts + 1))
        if test "$attempts" -ge 600; then
          log "timed out loading model: $llama_id"
          exit 1
        fi
        sleep 2
      done
      log "model loaded: $llama_id"
    fi
  else
    log "registering model $model"
    if ! reg_response=$(curl -sS -X POST http://localhost:9931/models \
      -H 'Content-Type: application/json' \
      -d '{"model":"'"$model"'"}' \
      -w '\\n%{http_code}'); then
      log "llama.cpp register request failed: $model"
      exit 1
    fi
    reg_status=$(printf '%s\\n' "$reg_response" | tail -n 1)
    reg_body=$(printf '%s\\n' "$reg_response" | sed '$d')
    case "$reg_status" in
      2??) ;;
      500)
        if ! printf '%s\\n' "$reg_body" | grep -q '"message"[[:space:]]*:[[:space:]]*"model limit reached, try again later"'; then
          log "llama.cpp rejected model registration (HTTP $reg_status): $model"
          exit 1
        fi
        log "model registration continues after capacity eviction: $model"
        reg_attempts=0
        until model_state=$(curl -sf http://localhost:9931/models) && printf '%s\\n' "$model_state" | sed 's/},{/}\\n{/g' | grep -q '"id"[[:space:]]*:[[:space:]]*"'$repo; do
          reg_attempts=$((reg_attempts + 1))
          if test "$reg_attempts" -ge 300; then
            log "timed out waiting for model registration: $model"
            exit 1
          fi
          sleep 2
        done
        log "model registered after eviction: $repo"
        ;;
      *)
        log "llama.cpp rejected model registration (HTTP $reg_status): $model"
        exit 1
        ;;
    esac
  fi
done

log 'synchronizing OmniRoute provider'
if ! curl -sf -H "Cookie: auth_token=$token" \
  http://localhost:20128/api/providers | grep -q 'llama.cpp (local)'; then
  curl -sf -H "Cookie: auth_token=$token" -H 'Content-Type: application/json' \
    -d '{"provider":"llama-cpp","apiKey":"sk-no-key-required","name":"llama.cpp (local)","defaultModel":"llama-cpp/${defaultModel}","providerSpecificData":{"baseUrl":"http://localhost:9931/v1"}}' \
    http://localhost:20128/api/providers > /dev/null
  log 'OmniRoute provider registered'
else
  log 'OmniRoute provider already registered'
fi
log 'bootstrap complete'
`;
}
