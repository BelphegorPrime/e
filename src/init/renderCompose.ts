import {
  llamaCppImage,
  llamaGpuCompose,
  type HardwareVendor,
} from '../hardware/index.js';
import Mustache from 'mustache';
import { STACK_NETWORK } from '../constants.js';
import type { LocalRuntime } from './localRuntimes.js';

/** Compose template; conditional blocks keep each local runtime self-contained. */
const TEMPLATE = `# Local OmniRoute gateway with {{{runtimeSummary}}}.
# Hardware detected: {{{vendor}}} -> {{{image}}}
# Start with: docker compose -f .e/compose.yaml up -d
# OmniRoute secrets (OMNIROUTE_INITIAL_PASSWORD, JWT_SECRET, API_KEY_SECRET) are
# interpolated from .e/.env — e init seeds random values there; there are no
# fallback defaults, so an unseeded stack simply has no known password.
{{#anyRuntime}}# The bootstrap service registers each local runtime as an OmniRoute provider.
# In OmniRoute Dashboard -> Providers, the registered runtimes point at their
# host-published base URLs; download models on demand with
# \`e <runtime> download <model>\`.
#{{/anyRuntime}}{{^anyRuntime}}# No local inference runtime was selected; add external providers in OmniRoute.{{/anyRuntime}}
# Networking: e-net contains redis{{#llama}}, llama.cpp{{/llama}}{{#ollama}}, Ollama{{/ollama}}{{#vllm}}, vLLM{{/vllm}}{{#anyRuntime}}, bootstrap{{/anyRuntime}}, OmniRoute,
# and the egress monitor. Services marked \`network_mode: "service:egress"\` share
# the egress container's network namespace, so a run that joins the same
# namespace (\`e spawn\` in local-stack mode) reaches them on loopback: Searxng at
# http://localhost:8080 (used by the \`web_search\`/\`fetch_content\` tools), the
# runtimes at their loopback ports, and OmniRoute at localhost:20128. The
# untrusted agent still cannot reach them by Docker DNS aliases (no e-net join).
# The published host ports stay bound to 127.0.0.1: only the host's own browser
# and CLI (e spawn, e serve) reach the dashboard; untrusted LAN peers cannot.

services:
  egress:
    build:
      context: ./egress
    image: e-egress
    container_name: e-egress
    restart: unless-stopped
    cap_add:
      - NET_ADMIN
    dns:
      - 127.0.0.1
    networks:
      {{{stackNetwork}}}:
    volumes:
      - ./egress-blacklist:/etc/egress.d/dnsmasq.blacklist:rw
      - egress-logs:/var/log/egress
    ports:
      - "127.0.0.1:20128:20128"
      - "127.0.0.1:20129:20129"
{{#llama}}      - "127.0.0.1:9931:9931"
{{/llama}}{{#ollama}}      - "127.0.0.1:11434:11434"
{{/ollama}}{{#vllm}}      - "127.0.0.1:8000:8000"
{{/vllm}}
  omniroute:
    image: diegosouzapw/omniroute:latest
    container_name: omniroute
    restart: unless-stopped
    stop_grace_period: 40s
    network_mode: "service:egress"
    depends_on:
      egress:
        condition: service_started
      redis:
        condition: service_healthy
{{#llama}}      llama:
        condition: service_started
{{/llama}}{{#ollama}}      ollama:
        condition: service_started
{{/ollama}}{{#vllm}}      vllm:
        condition: service_started
{{/vllm}}    environment:
      DATA_DIR: /app/data
      PORT: "20128"
      REDIS_URL: redis://localhost:6379
      LOCAL_HOSTNAMES: localhost
      OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS: "true"
      JWT_SECRET: \${JWT_SECRET}
      API_KEY_SECRET: \${API_KEY_SECRET}
      INITIAL_PASSWORD: \${OMNIROUTE_INITIAL_PASSWORD}
      OMNIROUTE_BOOTSTRAPPED: "true"
      REQUIRE_API_KEY: "false"
      OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT: "4"
    volumes:
      - omniroute-data:/app/data
{{#anyRuntime}}
  bootstrap:
    image: curlimages/curl:latest
    network_mode: "service:egress"
    depends_on:
      egress:
        condition: service_started
      omniroute:
        condition: service_started
{{#llama}}      llama:
        condition: service_started
{{/llama}}{{#ollama}}      ollama:
        condition: service_started
{{/ollama}}{{#vllm}}      vllm:
        condition: service_started
{{/vllm}}    environment:
      INITIAL_PASSWORD: \${OMNIROUTE_INITIAL_PASSWORD}
    volumes:
      - ./bootstrap.sh:/bootstrap.sh:ro
    entrypoint: ["/bin/sh", "/bootstrap.sh"]
    restart: "no"
{{/anyRuntime}}
{{#llama}}  llama:
    image: {{{image}}}
    container_name: llama
    restart: unless-stopped
    network_mode: "service:egress"
    depends_on:
      egress:
        condition: service_started
    environment:
      LLAMA_ARG_HOST: "0.0.0.0"
      LLAMA_ARG_PORT: "9931"
      LLAMA_ARG_CTX_SIZE: "32768"
      LLAMA_ARG_N_PARALLEL: "1"
      LLAMA_ARG_MODELS_MAX: "1"
    volumes:
      - llama-data:/root/.cache
{{{gpu}}}{{/llama}}{{#ollama}}
  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    restart: unless-stopped
    network_mode: "service:egress"
    depends_on:
      egress:
        condition: service_started
    environment:
      OLLAMA_HOST: "0.0.0.0"
    volumes:
      - ollama-data:/root/.ollama
{{/ollama}}{{#vllm}}
  vllm:
    image: vllm/vllm-openai:latest
    container_name: vllm
    restart: unless-stopped
    network_mode: "service:egress"
    depends_on:
      egress:
        condition: service_started
    environment:
      VLLM_HOST: "0.0.0.0"
    volumes:
      - vllm-data:/root/.cache
{{/vllm}}
  redis:
    image: redis:8-alpine
    container_name: omniroute-redis
    restart: unless-stopped
    network_mode: "service:egress"
    depends_on:
      egress:
        condition: service_started
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  searxng:
    image: searxng/searxng:latest
    container_name: e-searxng
    restart: unless-stopped
    network_mode: "service:egress"
    depends_on:
      egress:
        condition: service_started
    environment:
      SEARXNG_BASE_URL: http://localhost:8080/
    volumes:
      - searxng-data:/etc/searxng
    healthcheck:
      test: ["CMD", "python3", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8080/healthz')"]
      interval: 10s
      timeout: 5s
      retries: 5

networks:
  {{{stackNetwork}}}:
    name: {{{stackNetwork}}}
volumes:
  omniroute-data:
    name: omniroute-data
{{#llama}}  llama-data:
    name: llama-data
{{/llama}}{{#ollama}}  ollama-data:
    name: ollama-data
{{/ollama}}{{#vllm}}  vllm-data:
    name: vllm-data
{{/vllm}}  redis-data:
    name: redis-data
  searxng-data:
    name: e-searxng-data
  egress-logs:
    name: e-egress-logs
`;

const RUNTIME_LABELS: Readonly<Record<LocalRuntime, string>> = {
  llamacpp: 'llama.cpp',
  ollama: 'Ollama',
  vllm: 'vLLM',
};

/** Renders the local OmniRoute + selected runtime(s) development stack for `vendor`'s GPU. */
export function renderCompose(
  vendor: HardwareVendor = 'cpu',
  runtimes: readonly LocalRuntime[] = ['llamacpp']
): string {
  const image = llamaCppImage(vendor);
  const gpu = llamaGpuCompose(vendor);
  const llama = runtimes.includes('llamacpp');
  const ollama = runtimes.includes('ollama');
  const vllm = runtimes.includes('vllm');
  const anyRuntime = runtimes.length > 0;
  const runtimeSummary =
    runtimes.length > 0
      ? runtimes.map(runtime => RUNTIME_LABELS[runtime]).join(', ')
      : 'no local inference runtime selected';
  return Mustache.render(TEMPLATE, {
    vendor,
    image,
    gpu,
    llama,
    ollama,
    vllm,
    anyRuntime,
    runtimeSummary,
    stackNetwork: STACK_NETWORK,
  });
}
