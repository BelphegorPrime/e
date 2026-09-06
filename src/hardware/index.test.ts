import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseVendor, llamaCppImage, llamaGpuCompose } from './index';

const SIGNALS = {
  platform: 'linux',
  nvidiaSmiAvailable: false,
  amdKfdPresent: false,
  rocminfoAvailable: false,
  intelGpuPresent: false,
};

test('chooseVendor: a non-Linux platform always falls back to cpu', () => {
  assert.equal(
    chooseVendor({ ...SIGNALS, platform: 'darwin', nvidiaSmiAvailable: true }),
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

test('llamaCppImage: maps each vendor to its upstream llama.cpp server image', () => {
  assert.equal(llamaCppImage('cpu'), 'ghcr.io/ggml-org/llama.cpp:server');
  assert.equal(llamaCppImage('nvidia'), 'ghcr.io/ggml-org/llama.cpp:server-cuda');
  assert.equal(llamaCppImage('amd'), 'ghcr.io/ggml-org/llama.cpp:server-rocm');
  assert.equal(llamaCppImage('intel'), 'ghcr.io/ggml-org/llama.cpp:server-intel');
});

test('llamaGpuCompose: cpu needs no device passthrough', () => {
  assert.equal(llamaGpuCompose('cpu'), '');
});

test('llamaGpuCompose: nvidia reserves a GPU via the compose deploy spec', () => {
  const fragment = llamaGpuCompose('nvidia');
  assert.match(fragment, /driver: nvidia/);
  assert.match(fragment, /capabilities: \[gpu\]/);
});

test('llamaGpuCompose: amd passes through /dev/kfd and /dev/dri', () => {
  const fragment = llamaGpuCompose('amd');
  assert.match(fragment, /\/dev\/kfd/);
  assert.match(fragment, /\/dev\/dri/);
});

test('llamaGpuCompose: intel passes through /dev/dri', () => {
  assert.match(llamaGpuCompose('intel'), /\/dev\/dri/);
});
