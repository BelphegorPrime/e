import fs from 'fs';
import { execSync } from 'child_process';

/** GPU vendor whose Docker passthrough shapes the llama.cpp image and service. */
export type HardwareVendor = 'nvidia' | 'amd' | 'intel' | 'cpu';

/** Host facts `chooseVendor` needs; gathered by `detectHardware`, the one impure edge. */
export interface HardwareSignals {
  platform: string;
  nvidiaSmiAvailable: boolean;
  amdKfdPresent: boolean;
  rocminfoAvailable: boolean;
  intelGpuPresent: boolean;
}

/**
 * Picks the best-supported GPU vendor from host signals, purely. Container GPU
 * passthrough is engine- and platform-specific: on Linux the
 * nvidia-container-toolkit, ROCm (`/dev/kfd`), and SYCL (`/dev/dri`) paths all
 * work; on Windows only NVIDIA does, through Docker Desktop's WSL 2 backend
 * (the compose `deploy.resources.reservations.devices` spec is honoured there),
 * so an NVIDIA GPU counts and everything else is `cpu`; on macOS no engine
 * passes a GPU into a container, so it is always `cpu`.
 */
export function chooseVendor(signals: HardwareSignals): HardwareVendor {
  if (signals.platform === 'win32') {
    return signals.nvidiaSmiAvailable ? 'nvidia' : 'cpu';
  }
  if (signals.platform !== 'linux') return 'cpu';
  if (signals.nvidiaSmiAvailable) return 'nvidia';
  if (signals.amdKfdPresent || signals.rocminfoAvailable) return 'amd';
  if (signals.intelGpuPresent) return 'intel';
  return 'cpu';
}

/** Detects the host's GPU vendor by probing for vendor-specific tools/devices. */
export function detectHardware(): HardwareVendor {
  return chooseVendor(gatherHardwareSignals());
}

function gatherHardwareSignals(): HardwareSignals {
  return {
    platform: process.platform,
    nvidiaSmiAvailable: commandSucceeds('nvidia-smi -L'),
    amdKfdPresent: fs.existsSync('/dev/kfd'),
    rocminfoAvailable: commandSucceeds('rocminfo'),
    intelGpuPresent: intelGpuPresent(),
  };
}

function commandSucceeds(command: string): boolean {
  try {
    execSync(command, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function intelGpuPresent(): boolean {
  try {
    const lspci = execSync('lspci', { encoding: 'utf8' });
    return /VGA|3D|Display/.test(lspci) && /Intel/.test(lspci);
  } catch {
    return false;
  }
}

const LLAMA_CPP_IMAGES: Record<HardwareVendor, string> = {
  nvidia: 'ghcr.io/ggml-org/llama.cpp:server-cuda',
  amd: 'ghcr.io/ggml-org/llama.cpp:server-rocm',
  intel: 'ghcr.io/ggml-org/llama.cpp:server-intel',
  cpu: 'ghcr.io/ggml-org/llama.cpp:server',
};

/** The llama.cpp server image best matching `vendor` (see docs/docker.md upstream). */
export function llamaCppImage(vendor: HardwareVendor): string {
  return LLAMA_CPP_IMAGES[vendor];
}

/**
 * Compose service fragment (4-space indented) granting the llama service
 * access to `vendor`'s GPU; empty for `cpu`, which needs no device passthrough.
 */
export function llamaGpuCompose(vendor: HardwareVendor): string {
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
