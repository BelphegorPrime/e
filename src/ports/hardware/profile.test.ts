import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProfile,
  chooseVendor,
  describeHardware,
  type HardwareSignals,
} from './profile.js';

const GB = 1024 ** 3;

const SIGNALS: HardwareSignals = {
  platform: 'linux',
  arch: 'x64',
  cpuCount: 8,
  totalMemoryBytes: 16 * GB,
  nvidiaSmiAvailable: false,
  amdKfdPresent: false,
  rocminfoAvailable: false,
  intelGpuPresent: false,
  gpus: [],
  unifiedMemory: false,
};

test('chooseVendor: macOS always falls back to cpu (no container GPU passthrough)', () => {
  assert.equal(
    chooseVendor({ ...SIGNALS, platform: 'darwin', nvidiaSmiAvailable: true }),
    'cpu'
  );
});

test('chooseVendor: Windows passes only NVIDIA through (Docker Desktop WSL 2 backend)', () => {
  assert.equal(
    chooseVendor({ ...SIGNALS, platform: 'win32', nvidiaSmiAvailable: true }),
    'nvidia'
  );
  assert.equal(
    chooseVendor({
      ...SIGNALS,
      platform: 'win32',
      amdKfdPresent: true,
      rocminfoAvailable: true,
      intelGpuPresent: true,
    }),
    'cpu'
  );
});

test('chooseVendor: nvidia-smi wins over every other signal', () => {
  assert.equal(
    chooseVendor({
      ...SIGNALS,
      nvidiaSmiAvailable: true,
      amdKfdPresent: true,
      intelGpuPresent: true,
    }),
    'nvidia'
  );
});

test('chooseVendor: /dev/kfd or rocminfo selects amd', () => {
  assert.equal(chooseVendor({ ...SIGNALS, amdKfdPresent: true }), 'amd');
  assert.equal(chooseVendor({ ...SIGNALS, rocminfoAvailable: true }), 'amd');
});

test('chooseVendor: an Intel GPU selects intel', () => {
  assert.equal(chooseVendor({ ...SIGNALS, intelGpuPresent: true }), 'intel');
});

test('chooseVendor: no signals falls back to cpu', () => {
  assert.equal(chooseVendor(SIGNALS), 'cpu');
});

test('buildProfile: sums dedicated VRAM across every detected GPU', () => {
  const profile = buildProfile({
    ...SIGNALS,
    nvidiaSmiAvailable: true,
    gpus: [
      { vendor: 'nvidia', name: 'RTX 4090', vramBytes: 24 * GB },
      { vendor: 'nvidia', name: 'RTX 3090', vramBytes: 24 * GB },
    ],
  });
  assert.equal(profile.vendor, 'nvidia');
  assert.equal(profile.totalVramBytes, 48 * GB);
  assert.equal(profile.gpus.length, 2);
});

test('buildProfile: a GPU sharing system memory contributes no dedicated VRAM', () => {
  const profile = buildProfile({
    ...SIGNALS,
    intelGpuPresent: true,
    unifiedMemory: true,
    gpus: [{ vendor: 'intel', name: 'Iris Xe', vramBytes: 0 }],
  });
  assert.equal(profile.totalVramBytes, 0);
  assert.equal(profile.unifiedMemory, true);
  assert.equal(profile.totalMemoryBytes, 16 * GB);
});

test('buildProfile: carries platform, arch and CPU count through unchanged', () => {
  const profile = buildProfile({
    ...SIGNALS,
    platform: 'darwin',
    arch: 'arm64',
  });
  assert.equal(profile.platform, 'darwin');
  assert.equal(profile.arch, 'arm64');
  assert.equal(profile.cpuCount, 8);
});

test('describeHardware: names the vendor, every GPU and the system memory', () => {
  const summary = describeHardware(
    buildProfile({
      ...SIGNALS,
      nvidiaSmiAvailable: true,
      gpus: [{ vendor: 'nvidia', name: 'RTX 4090', vramBytes: 24 * GB }],
    })
  );
  assert.match(summary, /nvidia/);
  assert.match(summary, /RTX 4090/);
  assert.match(summary, /24\.0 GB VRAM/);
  assert.match(summary, /16\.0 GB RAM/);
});

test('describeHardware: says so when no GPU can be passed into a container', () => {
  const summary = describeHardware(buildProfile(SIGNALS));
  assert.match(summary, /no GPU/);
});

test('describeHardware: calls out a unified memory pool', () => {
  const summary = describeHardware(
    buildProfile({
      ...SIGNALS,
      platform: 'darwin',
      arch: 'arm64',
      unifiedMemory: true,
      gpus: [{ vendor: 'apple', name: 'Apple M3 Max', vramBytes: 0 }],
    })
  );
  assert.match(summary, /unified memory/);
});
