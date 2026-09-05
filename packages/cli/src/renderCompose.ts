import {
  llamaCppImage,
  llamaGpuCompose,
  type HardwareVendor,
} from './hardware/index';

/**
 * The stack edge network the run container joins so it can reach OmniRoute
 * directly by service alias instead of hopping through the host. Fixed name so
 * `e spawn` (executeSpawn) attaches the run container to it. OmniRoute aliases
 * `host.docker.internal` here, so the baked agent default base URL
 * (`http://host.docker.internal:20128/v1`) resolves to the container itself
 * rather than the host bridge gateway, which cannot reach the loopback-bound
 * host port. See docs/security/attack-surface.md, Zone 3.
 */
export const OMNIROUTE_EDGE_NETWORK = 'omniroute-edge';

/** The stack-internal network: redis, llama, bootstrap, and OmniRoute itself. */
const OMNIROUTE_STACK_NETWORK = 'omniroute-stack';

/** Renders the local OmniRoute + llama.cpp development stack for `vendor`'s GPU. */
export function renderCompose(vendor: HardwareVendor = 'cpu'): string {
  const image = llamaCppImage(vendor);
  const gpu = llamaGpuCompose(vendor);
  return `# Local OmniRoute gateway with llama.cpp as a self-hosted provider.
# Hardware detected: ${vendor} -> ${image}
# Start with: docker compose -f .e/compose.yaml up -d
# OmniRoute secrets (OMNIROUTE_INITIAL_PASSWORD, JWT_SECRET, API_KEY_SECRET) are
# interpolated from .e/.env — e init seeds random values there; there are no
# fallback defaults, so an unseeded stack simply has no known password.
# The bootstrap service downloads the model from Hugging Face through llama.cpp's API.
# In OmniRoute Dashboard -> Providers, add llama.cpp with base URL http://llama:9931/v1.
#
# Networking: the stack is split into two networks.
#   omniroute-stack — redis, llama.cpp, bootstrap, and OmniRoute's backplane.
#                     Nothing on it publishes a host port except OmniRoute/llama,
#                     and the harness run container never joins it, so the
#                     untrusted agent cannot reach Redis or llama.cpp directly.
#   omniroute-edge  — OmniRoute only, aliased as host.docker.internal. The run
#                     container attaches here (e spawn does this when it sees
#                     .e/compose.yaml), so its baked base URL
#                     http://host.docker.internal:20128/v1 resolves straight to
#                     OmniRoute's container IP via compose DNS — no host hop.
# The published host ports stay bound to 127.0.0.1: only the host's own browser
# and CLI (e spawn, e serve) reach the dashboard; untrusted LAN peers cannot.

services:
  omniroute:
    image: diegosouzapw/omniroute:latest
    container_name: omniroute
    restart: unless-stopped
    stop_grace_period: 40s
    depends_on:
      redis:
        condition: service_healthy
      llama:
        condition: service_started
    environment:
      DATA_DIR: /app/data
      PORT: "20128"
      REDIS_URL: redis://redis:6379
      LOCAL_HOSTNAMES: llama
      OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS: "true"
      JWT_SECRET: \${JWT_SECRET}
      API_KEY_SECRET: \${API_KEY_SECRET}
      INITIAL_PASSWORD: \${OMNIROUTE_INITIAL_PASSWORD}
      OMNIROUTE_BOOTSTRAPPED: "true"
      REQUIRE_API_KEY: "false"
    ports:
      - "127.0.0.1:20128:20128"
    networks:
      ${OMNIROUTE_STACK_NETWORK}: {}
      omniroute-edge:
        aliases:
          - host.docker.internal
    volumes:
      - ./volumes/omniroute-data:/app/data

  bootstrap:
    image: curlimages/curl:latest
    depends_on:
      omniroute:
        condition: service_started
      llama:
        condition: service_started
    environment:
      INITIAL_PASSWORD: \${OMNIROUTE_INITIAL_PASSWORD}
    networks:
      - ${OMNIROUTE_STACK_NETWORK}
    volumes:
      - ./bootstrap.sh:/bootstrap.sh:ro
    entrypoint: ["/bin/sh", "/bootstrap.sh"]
    restart: "no"

  llama:
    image: ${image}
    container_name: llama
    restart: unless-stopped
    environment:
      LLAMA_ARG_HOST: "0.0.0.0"
      LLAMA_ARG_PORT: "9931"
      LLAMA_ARG_CTX_SIZE: "65536"
      LLAMA_ARG_N_PARALLEL: "2"
    ports:
      - "127.0.0.1:9931:9931"
    networks:
      - ${OMNIROUTE_STACK_NETWORK}
    volumes:
      - ./volumes/llama-data:/root/.cache
${gpu}
  redis:
    image: redis:8-alpine
    container_name: omniroute-redis
    restart: unless-stopped
    expose:
      - "6379"
    networks:
      - ${OMNIROUTE_STACK_NETWORK}
    volumes:
      - ./volumes/redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

networks:
  ${OMNIROUTE_STACK_NETWORK}:
    name: ${OMNIROUTE_STACK_NETWORK}
  omniroute-edge:
    name: omniroute-edge
`;
}
