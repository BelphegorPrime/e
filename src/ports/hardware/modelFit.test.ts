import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, type HardwareSignals } from './profile.js';
import {
  activeWeightBytes,
  affordableCatalogs,
  affordableModels,
  classifyModelFit,
  describeModelFit,
  isMixtureOfExperts,
} from './modelFit.js';
import type { ModelCatalogEntry } from '../../core/modelStatus.js';

const GB = 1024 ** 3;

const BASE: HardwareSignals = {
  platform: 'linux',
  arch: 'x64',
  cpuCount: 8,
  totalMemoryBytes: 64 * GB,
  nvidiaSmiAvailable: false,
  amdKfdPresent: false,
  rocminfoAvailable: false,
  intelGpuPresent: false,
  gpus: [],
  unifiedMemory: false,
};

/** One 24 GB NVIDIA GPU, 64 GB of system RAM. */
const WORKSTATION = buildProfile({
  ...BASE,
  nvidiaSmiAvailable: true,
  gpus: [{ vendor: 'nvidia', name: 'RTX 4090', vramBytes: 24 * GB }],
});

/** No GPU, 16 GB of system RAM. */
const LAPTOP = buildProfile({ ...BASE, totalMemoryBytes: 16 * GB });

/** Apple Silicon: one 64 GB pool shared by CPU and GPU. */
const UNIFIED = buildProfile({
  ...BASE,
  platform: 'darwin',
  arch: 'arm64',
  unifiedMemory: true,
  gpus: [{ vendor: 'apple', name: 'Apple M3 Max', vramBytes: 0 }],
});

const DENSE_SMALL: ModelCatalogEntry = {
  id: 'org/dense-8b',
  sizeBytes: 5 * GB,
  paramsB: 8,
  activeParamsB: 8,
};
const DENSE_MID: ModelCatalogEntry = {
  id: 'org/dense-27b',
  sizeBytes: 16 * GB,
  paramsB: 27,
  activeParamsB: 27,
};
const DENSE_HUGE: ModelCatalogEntry = {
  id: 'org/dense-120b',
  sizeBytes: 40 * GB,
  paramsB: 120,
  activeParamsB: 120,
};
const MOE: ModelCatalogEntry = {
  id: 'org/moe-35b-a3b',
  sizeBytes: 30 * GB,
  paramsB: 35,
  activeParamsB: 3,
};
const ABSURD: ModelCatalogEntry = {
  id: 'org/dense-1t',
  sizeBytes: 400 * GB,
  paramsB: 1000,
  activeParamsB: 1000,
};

test('isMixtureOfExperts: only a model with fewer active than total params is MoE', () => {
  assert.equal(isMixtureOfExperts(MOE), true);
  assert.equal(isMixtureOfExperts(DENSE_MID), false);
});

test('activeWeightBytes: an MoE holds only its active share of the weights hot', () => {
  assert.equal(activeWeightBytes(DENSE_MID), DENSE_MID.sizeBytes);
  assert.ok(Math.abs(activeWeightBytes(MOE) - (30 * GB * 3) / 35) < 1);
});

test('classifyModelFit: a model whose weights and KV cache fit VRAM is a gpu fit', () => {
  assert.equal(classifyModelFit(DENSE_MID, WORKSTATION), 'gpu');
  assert.equal(classifyModelFit(DENSE_SMALL, WORKSTATION), 'gpu');
});

test('classifyModelFit: an MoE too big for VRAM still fits when its active params do', () => {
  assert.equal(classifyModelFit(MOE, WORKSTATION), 'gpu-moe');
});

test('classifyModelFit: a dense model too big for VRAM falls back to system RAM', () => {
  assert.equal(classifyModelFit(DENSE_HUGE, WORKSTATION), 'host');
});

test('classifyModelFit: nothing fits a model larger than VRAM and RAM together', () => {
  assert.equal(classifyModelFit(ABSURD, WORKSTATION), 'too-large');
  assert.equal(classifyModelFit(ABSURD, UNIFIED), 'too-large');
});

test('classifyModelFit: without a GPU only system RAM decides', () => {
  assert.equal(classifyModelFit(DENSE_SMALL, LAPTOP), 'host');
  assert.equal(classifyModelFit(DENSE_MID, LAPTOP), 'too-large');
});

test('classifyModelFit: unified memory weighs a model against the whole pool', () => {
  assert.equal(classifyModelFit(DENSE_HUGE, UNIFIED), 'gpu');
  // The same pool backs CPU and GPU, so an MoE gains nothing by offloading.
  assert.equal(classifyModelFit(MOE, UNIFIED), 'gpu');
});

test('affordableModels: drops what does not fit and sorts the rest best-fit first', () => {
  const ranked = affordableModels(
    [ABSURD, DENSE_HUGE, MOE, DENSE_MID],
    WORKSTATION
  );
  assert.deepEqual(
    ranked.map(m => m.id),
    [DENSE_MID.id, MOE.id, DENSE_HUGE.id]
  );
});

test('affordableModels: an already-configured model stays offered even when it does not fit', () => {
  const ranked = affordableModels([ABSURD, DENSE_SMALL], LAPTOP, [ABSURD.id]);
  assert.deepEqual(
    ranked.map(m => m.id),
    [DENSE_SMALL.id, ABSURD.id]
  );
});

test('affordableCatalogs: filters every runtime catalog against the same hardware', () => {
  const filtered = affordableCatalogs(
    {
      llamacpp: [DENSE_MID, ABSURD],
      ollama: [ABSURD],
      vllm: [DENSE_SMALL],
    },
    WORKSTATION
  );
  assert.deepEqual(
    filtered.llamacpp.map(m => m.id),
    [DENSE_MID.id]
  );
  assert.deepEqual(filtered.ollama, []);
  assert.deepEqual(
    filtered.vllm.map(m => m.id),
    [DENSE_SMALL.id]
  );
});

test('describeModelFit: says where the weights land, naming the MoE active size', () => {
  assert.match(describeModelFit(DENSE_MID, WORKSTATION), /VRAM/);
  assert.match(describeModelFit(MOE, WORKSTATION), /3B active/);
  assert.match(describeModelFit(DENSE_HUGE, WORKSTATION), /RAM/);
  assert.match(describeModelFit(DENSE_HUGE, UNIFIED), /unified memory/);
  assert.match(describeModelFit(ABSURD, WORKSTATION), /exceeds/);
});
