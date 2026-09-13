import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import {
  buildProfile,
  type GpuDevice,
  type HardwareProfile,
  type HardwareSignals,
} from './profile.js';

/**
 * Probes the host for everything {@link HardwareProfile} reports. The one
 * impure edge of this port: every decision made from the result is pure and
 * tested against fabricated signals.
 */
export function detectHardware(): HardwareProfile {
  return buildProfile(gatherHardwareSignals());
}

/** Reads the raw host facts. Every probe degrades to "absent" rather than throwing. */
export function gatherHardwareSignals(): HardwareSignals {
  const platform = process.platform;
  const arch = process.arch;
  const nvidiaSmiAvailable = commandSucceeds('nvidia-smi -L');
  const appleSilicon = platform === 'darwin' && arch === 'arm64';

  const gpus: GpuDevice[] = [
    ...(nvidiaSmiAvailable ? nvidiaGpus() : []),
    ...amdGpus(),
    ...intelGpus(),
    ...(appleSilicon ? appleGpus() : []),
  ];

  return {
    platform,
    arch,
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    nvidiaSmiAvailable,
    amdKfdPresent: fs.existsSync('/dev/kfd'),
    rocminfoAvailable: commandSucceeds('rocminfo'),
    intelGpuPresent: intelGpuPresent(),
    gpus,
    // A host is unified-memory when no GPU brings memory of its own: Apple
    // Silicon, or a machine whose only GPU is integrated.
    unifiedMemory:
      appleSilicon ||
      (gpus.length > 0 && gpus.every(gpu => gpu.vramBytes === 0)),
  };
}

/** `nvidia-smi` reports name and total memory per GPU; memory is in MiB. */
function nvidiaGpus(): GpuDevice[] {
  const output = commandOutput(
    'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits'
  );
  if (output === undefined) return [];
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [name, memoryMib] = line.split(',').map(part => part.trim());
      return {
        vendor: 'nvidia' as const,
        name: name || 'NVIDIA GPU',
        vramBytes: (Number(memoryMib) || 0) * 1024 * 1024,
      };
    });
}

/** amdgpu exposes exact VRAM in sysfs, so no ROCm tooling has to be installed. */
function amdGpus(): GpuDevice[] {
  return drmDevices()
    .filter(device => driverOf(device) === 'amdgpu')
    .map(device => ({
      vendor: 'amd' as const,
      name: readText(path.join(device, 'product_name')) ?? 'AMD GPU',
      // An APU has no carve-out to report; it draws on system memory instead.
      vramBytes: readNumber(path.join(device, 'mem_info_vram_total')) ?? 0,
    }));
}

/**
 * i915/xe report local memory only for discrete parts (Arc); an integrated GPU
 * has no `lmem_total_bytes` and shares system memory, which is exactly the
 * `vramBytes: 0` case {@link HardwareSignals.unifiedMemory} keys off.
 */
function intelGpus(): GpuDevice[] {
  return drmDevices()
    .filter(device => ['i915', 'xe'].includes(driverOf(device) ?? ''))
    .map(device => ({
      vendor: 'intel' as const,
      name: 'Intel GPU',
      vramBytes: readNumber(path.join(device, 'lmem_total_bytes')) ?? 0,
    }));
}

/** Apple Silicon's GPU has no memory of its own; the SoC pool is the whole RAM. */
function appleGpus(): GpuDevice[] {
  const brand = commandOutput('sysctl -n machdep.cpu.brand_string')?.trim();
  return [
    { vendor: 'apple', name: brand || 'Apple Silicon GPU', vramBytes: 0 },
  ];
}

/** The `cardN` device directories under sysfs, or none where sysfs is absent. */
function drmDevices(): string[] {
  try {
    return fs
      .readdirSync('/sys/class/drm')
      .filter(name => /^card\d+$/.test(name))
      .map(name => path.join('/sys/class/drm', name, 'device'));
  } catch {
    return [];
  }
}

/** The kernel driver bound to a sysfs device, from its `uevent`. */
function driverOf(device: string): string | undefined {
  const uevent = readText(path.join(device, 'uevent'));
  return /^DRIVER=(.+)$/m.exec(uevent ?? '')?.[1];
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return undefined;
  }
}

function readNumber(file: string): number | undefined {
  const text = readText(file);
  if (text === undefined) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function commandSucceeds(command: string): boolean {
  try {
    execSync(command, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function commandOutput(command: string): string | undefined {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

function intelGpuPresent(): boolean {
  const lspci = commandOutput('lspci');
  if (lspci === undefined) return false;
  return /VGA|3D|Display/.test(lspci) && /Intel/.test(lspci);
}
