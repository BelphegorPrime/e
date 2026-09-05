import {
  llamaCppImage,
  llamaGpuCompose,
  type HardwareVendor,
} from './hardware/index';

/** Renders the local OmniRoute + llama.cpp development stack for `vendor`'s GPU. */
export function renderCompose(vendor: HardwareVendor = 'cpu'): string {
  const image = llamaCppImage(vendor);
  const gpu = llamaGpuCompose(vendor);
  return `# Local OmniRoute gateway with llama.cpp as a self-hosted provider.
# Hardware detected: ${vendor} -> ${image}
# Start with: docker compose -f .e/compose.yaml up -d
# The bootstrap service downloads the model from Hugging Face through llama.cpp's API.
# In OmniRoute Dashboard -> Providers, add llama.cpp with base URL http://llama:9931/v1.

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
      JWT_SECRET: \${JWT_SECRET:-local-development-jwt-secret-32-bytes}
      API_KEY_SECRET: \${API_KEY_SECRET:-local-development-api-key-secret-32-bytes}
      INITIAL_PASSWORD: \${OMNIROUTE_INITIAL_PASSWORD:-local-development}
      OMNIROUTE_BOOTSTRAPPED: "true"
      REQUIRE_API_KEY: "false"
    ports:
      - "20128:20128"
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
      INITIAL_PASSWORD: \${OMNIROUTE_INITIAL_PASSWORD:-local-development}
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
    volumes:
      - ./volumes/llama-data:/root/.cache
${gpu}
  redis:
    image: redis:8-alpine
    container_name: omniroute-redis
    restart: unless-stopped
    expose:
      - "6379"
    volumes:
      - ./volumes/redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
`;
}