import { formatBytes } from '../../core/modelStatus.js';

/** GPU vendor whose Docker passthrough shapes the runtime images and services. */
export type HardwareVendor = 'nvidia' | 'amd' | 'intel' | 'cpu';

/**
 * One GPU found on the host. `vramBytes` counts **dedicated** video memory
 * only: an integrated GPU or an Apple Silicon SoC reports `0` and is covered by
 * {@link HardwareProfile.unifiedMemory} plus the system memory total instead.
 */
export interface GpuDevice {
  vendor: 'nvidia' | 'amd' | 'intel' | 'apple';
  name: string;
  vramBytes: number;
}

/** Host facts the pure derivations need; gathered by `detectHardware`, the one impure edge. */
export interface HardwareSignals {
  platform: string;
  arch: string;
  cpuCount: number;
  totalMemoryBytes: number;
  nvidiaSmiAvailable: boolean;
  amdKfdPresent: boolean;
  rocminfoAvailable: boolean;
  intelGpuPresent: boolean;
  /** Every GPU probed, with its dedicated VRAM. */
  gpus: readonly GpuDevice[];
  /** CPU and GPU draw on one memory pool (Apple Silicon, an Intel iGPU, an AMD APU). */
  unifiedMemory: boolean;
}

/**
 * Everything `e` knows about the host's inference capacity: which GPU (if any)
 * a container can use, and how much memory a model has to fit into. Derived
 * purely from {@link HardwareSignals}, so every consumer - compose rendering,
 * the image tables, the `e init` model filter - is testable without a GPU.
 */
export interface HardwareProfile {
  /** The passthrough vendor; `cpu` when no GPU reaches a container. */
  vendor: HardwareVendor;
  platform: string;
  arch: string;
  cpuCount: number;
  totalMemoryBytes: number;
  unifiedMemory: boolean;
  gpus: readonly GpuDevice[];
  /**
   * Dedicated VRAM summed over every GPU. All three runtimes can split a model
   * across GPUs (llama.cpp `--split-mode`, Ollama's scheduler, vLLM's tensor
   * parallelism), so the sum - not the largest single card - is the pool a
   * model has to fit into. Always `0` on a unified-memory host.
   */
  totalVramBytes: number;
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

/** Derives the full {@link HardwareProfile} from raw host signals, purely. */
export function buildProfile(signals: HardwareSignals): HardwareProfile {
  return {
    vendor: chooseVendor(signals),
    platform: signals.platform,
    arch: signals.arch,
    cpuCount: signals.cpuCount,
    totalMemoryBytes: signals.totalMemoryBytes,
    unifiedMemory: signals.unifiedMemory,
    gpus: signals.gpus,
    totalVramBytes: signals.unifiedMemory
      ? 0
      : signals.gpus.reduce((sum, gpu) => sum + gpu.vramBytes, 0),
  };
}

/** One line naming the vendor, the GPUs and the memory - for logs and the compose header. */
export function describeHardware(profile: HardwareProfile): string {
  const parts: string[] = [profile.vendor];
  if (profile.gpus.length === 0) {
    parts.push('no GPU detected');
  } else {
    parts.push(
      ...profile.gpus.map(gpu =>
        gpu.vramBytes > 0
          ? `${gpu.name} (${formatBytes(gpu.vramBytes)} VRAM)`
          : `${gpu.name} (shared memory)`
      )
    );
  }
  if (profile.vendor === 'cpu' && profile.gpus.length > 0) {
    parts.push('no GPU passthrough on this platform');
  }
  parts.push(
    profile.unifiedMemory
      ? `${formatBytes(profile.totalMemoryBytes)} unified memory`
      : `${formatBytes(profile.totalMemoryBytes)} RAM`
  );
  return parts.join(' · ');
}
