import {
  buildProfile,
  type HardwareProfile,
  type HardwareSignals,
} from './profile.js';

/** A bare Linux host: no GPU, 16 GB of RAM. */
const DEFAULT_SIGNALS: HardwareSignals = {
  platform: 'linux',
  arch: 'x64',
  cpuCount: 8,
  totalMemoryBytes: 16 * 1024 ** 3,
  nvidiaSmiAvailable: false,
  amdKfdPresent: false,
  rocminfoAvailable: false,
  intelGpuPresent: false,
  gpus: [],
  unifiedMemory: false,
};

/**
 * A {@link HardwareProfile} for tests, built from the same pure derivation the
 * real detection uses, so a fixture can never describe a host shape the
 * detector could not produce.
 */
export function testProfile(
  overrides: Partial<HardwareSignals> = {}
): HardwareProfile {
  return buildProfile({ ...DEFAULT_SIGNALS, ...overrides });
}

/** A host with one NVIDIA GPU of `vramBytes`, for GPU-path assertions. */
export function nvidiaProfile(
  vramBytes = 24 * 1024 ** 3,
  overrides: Partial<HardwareSignals> = {}
): HardwareProfile {
  return testProfile({
    nvidiaSmiAvailable: true,
    gpus: [{ vendor: 'nvidia', name: 'Test NVIDIA GPU', vramBytes }],
    ...overrides,
  });
}
