import type { LocalRuntime } from '../../core/localRuntimes.js';
import type { HardwareVendor } from './profile.js';

/**
 * The upstream image each local runtime publishes per GPU vendor. Every entry
 * is an image that actually exists upstream; where a vendor has no dedicated
 * build the comment says what the fallback really runs on, so a stack never
 * points at an invented tag.
 */
export const RUNTIME_IMAGES: Readonly<
  Record<LocalRuntime, Readonly<Record<HardwareVendor, string>>>
> = {
  // llama.cpp publishes one server image per backend (see its docs/docker.md).
  llamacpp: {
    nvidia: 'ghcr.io/ggml-org/llama.cpp:server-cuda',
    amd: 'ghcr.io/ggml-org/llama.cpp:server-rocm',
    intel: 'ghcr.io/ggml-org/llama.cpp:server-intel',
    cpu: 'ghcr.io/ggml-org/llama.cpp:server',
  },
  // Ollama ships CUDA support inside its default image and a separate ROCm
  // build for AMD. There is no oneAPI build, so an Intel host takes the
  // default image and runs on the CPU.
  ollama: {
    nvidia: 'ollama/ollama:latest',
    amd: 'ollama/ollama:rocm',
    intel: 'ollama/ollama:latest',
    cpu: 'ollama/ollama:latest',
  },
  // vLLM's own image is CUDA-only; AMD publishes the ROCm build, Intel the XPU
  // build, and the project's CPU wheels ship as a separate release repo.
  vllm: {
    nvidia: 'vllm/vllm-openai:latest',
    amd: 'rocm/vllm:latest',
    intel: 'intel/vllm:xpu',
    cpu: 'public.ecr.aws/q9t5s3a7/vllm-cpu-release-repo:latest',
  },
};

/** The image `runtime` should run for `vendor`'s GPU. */
export function runtimeImage(
  runtime: LocalRuntime,
  vendor: HardwareVendor
): string {
  return RUNTIME_IMAGES[runtime][vendor];
}

/**
 * Compose service fragment (4-space indented) granting a runtime service
 * access to `vendor`'s GPU; empty for `cpu`, which needs no device
 * passthrough. The same fragment serves llama.cpp, Ollama and vLLM: all three
 * reach a GPU through the engine's device plumbing, not through anything
 * runtime-specific.
 */
export function gpuComposeFragment(vendor: HardwareVendor): string {
  switch (vendor) {
    case 'nvidia':
      return `    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
`;
    case 'amd':
      return `    devices:
      - /dev/kfd
      - /dev/dri
    group_add:
      - video
`;
    case 'intel':
      return `    devices:
      - /dev/dri
`;
    case 'cpu':
      return '';
  }
}
