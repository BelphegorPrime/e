import {
  llamaCppImage,
  llamaGpuCompose,
  type HardwareVendor,
} from '../hardware/index.js';
/** The stack-internal network: redis, llama, bootstrap, OmniRoute, and egress backplane. */
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
# In OmniRoute Dashboard -> Providers, add llama.cpp with base URL http://localhost:9931/v1.
#
# Networking: the stack is split into two networks.
#   omniroute-stack — redis, llama.cpp, bootstrap, OmniRoute backplane, and egress
#                     monitor. Nothing on it publishes a host port except OmniRoute/llama,
#                     and the harness run container never joins it, so the
#                     untrusted agent cannot reach Redis or llama.cpp directly.
#   omniroute-edge  — OmniRoute + egress WAN gateway + run containers. All outbound
#                     traffic (stack services + agents) routes through the egress
#                     container's netns for DNS sinkholing and IP blacklist enforcement.
#                     OmniRoute aliased as host.docker.internal. The run container attaches
#                     here (e spawn does this when it sees .e/compose.yaml), so its baked
#                     base URL http://host.docker.internal:20128/v1 resolves straight to
#                     OmniRoute's container IP via compose DNS — no host hop.
# The published host ports stay bound to 127.0.0.1: only the host's own browser
# and CLI (e spawn, e serve) reach the dashboard; untrusted LAN peers cannot.

services:
  egress:
    image: e-egress
    container_name: e-egress
    restart: unless-stopped
    cap_add:
      - NET_ADMIN
    dns:
      - 127.0.0.1
    networks:
      ${OMNIROUTE_STACK_NETWORK}:
      omniroute-edge:
        aliases:
          - host.docker.internal
    volumes:
      - ./egress-blacklist:/etc/egress.d/dnsmasq.blacklist:rw
      - egress-logs:/var/log/egress
    ports:
      - "127.0.0.1:20128:20128"
      - "127.0.0.1:9931:9931"

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
      llama:
        condition: service_started
    environment:
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
    volumes:
      - omniroute-data:/app/data

  bootstrap:
    image: curlimages/curl:latest
    network_mode: "service:egress"
    depends_on:
      egress:
        condition: service_started
      omniroute:
        condition: service_started
      llama:
        condition: service_started
    environment:
      INITIAL_PASSWORD: \${OMNIROUTE_INITIAL_PASSWORD}
    volumes:
      - ./bootstrap.sh:/bootstrap.sh:ro
    entrypoint: ["/bin/sh", "/bootstrap.sh"]
    restart: "no"

  llama:
    image: ${image}
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
${gpu}
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

networks:
  ${OMNIROUTE_STACK_NETWORK}:
    name: ${OMNIROUTE_STACK_NETWORK}
  omniroute-edge:
    name: omniroute-edge

volumes:
  omniroute-data:
    name: omniroute-data
  llama-data:
    name: llama-data
  redis-data:
    name: redis-data
  egress-logs:
    name: e-egress-logs
`;
}
