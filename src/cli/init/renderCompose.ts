import {
  describeHardware,
  gpuComposeFragment,
  runtimeImage,
  buildProfile,
  type HardwareProfile,
} from '../../ports/hardware/index.js';
import Mustache from 'mustache';
import { STACK_NETWORK } from '../../shared/constants.js';
import {
  EGRESS_API_PORT,
  EGRESS_BLACKLIST_IP_MOUNT,
  EGRESS_BLACKLIST_MOUNT,
  EGRESS_LOG_MOUNT,
} from '../../sidecars/egress/contract/constants.js';
import type { LocalRuntime } from '../../core/localRuntimes.js';

/** Compose template; conditional blocks keep each local runtime self-contained. */
const TEMPLATE = `# Local OmniRoute gateway with {{{runtimeSummary}}}.
# Hardware detected: {{{hardwareSummary}}}
{{#runtimeImages}}#   {{{label}}} -> {{{image}}}
{{/runtimeImages}}# Start with: docker compose -f .e/compose.yaml up -d
# OmniRoute secrets (OMNIROUTE_INITIAL_PASSWORD, JWT_SECRET, API_KEY_SECRET) are
# interpolated from .e/.env - e init seeds random values there; there are no
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
      - ./egress-blacklist:${EGRESS_BLACKLIST_MOUNT}:rw
      - ./egress-iptables.rules:${EGRESS_BLACKLIST_IP_MOUNT}:ro
      - egress-logs:${EGRESS_LOG_MOUNT}
    ports:
      - "127.0.0.1:20128:20128"
      - "127.0.0.1:${EGRESS_API_PORT}:${EGRESS_API_PORT}"
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
    image: {{{llamaImage}}}
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
    image: {{{ollamaImage}}}
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
{{{gpu}}}{{/ollama}}{{#vllm}}
  vllm:
    image: {{{vllmImage}}}
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
{{{gpu}}}{{/vllm}}
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

/**
 * The fallback profile a caller gets without one: no GPU, no memory known, so
 * every runtime renders its CPU image and no device passthrough.
 */
const CPU_ONLY: HardwareProfile = buildProfile({
  platform: 'linux',
  arch: 'x64',
  cpuCount: 0,
  totalMemoryBytes: 0,
  nvidiaSmiAvailable: false,
  amdKfdPresent: false,
  rocminfoAvailable: false,
  intelGpuPresent: false,
  gpus: [],
  unifiedMemory: false,
});

const RUNTIME_LABELS: Readonly<Record<LocalRuntime, string>> = {
  llamacpp: 'llama.cpp',
  ollama: 'Ollama',
  vllm: 'vLLM',
};

/**
 * Renders the local OmniRoute + selected runtime(s) development stack for the
 * detected hardware. Each runtime takes the upstream image built for that GPU
 * vendor and the same device-passthrough fragment, so an NVIDIA host runs
 * CUDA builds of all three and an AMD host ROCm builds of all three.
 */
export function renderCompose(
  hardware: HardwareProfile = CPU_ONLY,
  runtimes: readonly LocalRuntime[] = ['llamacpp']
): string {
  const vendor = hardware.vendor;
  const gpu = gpuComposeFragment(vendor);
  const llama = runtimes.includes('llamacpp');
  const ollama = runtimes.includes('ollama');
  const vllm = runtimes.includes('vllm');
  const anyRuntime = runtimes.length > 0;
  const runtimeSummary =
    runtimes.length > 0
      ? runtimes.map(runtime => RUNTIME_LABELS[runtime]).join(', ')
      : 'no local inference runtime selected';
  return Mustache.render(TEMPLATE, {
    hardwareSummary: describeHardware(hardware),
    runtimeImages: runtimes.map(runtime => ({
      label: RUNTIME_LABELS[runtime],
      image: runtimeImage(runtime, vendor),
    })),
    llamaImage: runtimeImage('llamacpp', vendor),
    ollamaImage: runtimeImage('ollama', vendor),
    vllmImage: runtimeImage('vllm', vendor),
    gpu,
    llama,
    ollama,
    vllm,
    anyRuntime,
    runtimeSummary,
    stackNetwork: STACK_NETWORK,
  });
}
