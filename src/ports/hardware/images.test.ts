import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gpuComposeFragment, runtimeImage } from './images.js';

test('runtimeImage: llama.cpp maps each vendor to its upstream server image', () => {
  assert.equal(
    runtimeImage('llamacpp', 'cpu'),
    'ghcr.io/ggml-org/llama.cpp:server'
  );
  assert.equal(
    runtimeImage('llamacpp', 'nvidia'),
    'ghcr.io/ggml-org/llama.cpp:server-cuda'
  );
  assert.equal(
    runtimeImage('llamacpp', 'amd'),
    'ghcr.io/ggml-org/llama.cpp:server-rocm'
  );
  assert.equal(
    runtimeImage('llamacpp', 'intel'),
    'ghcr.io/ggml-org/llama.cpp:server-intel'
  );
});

test('runtimeImage: Ollama takes its ROCm build on amd and the default build elsewhere', () => {
  assert.equal(runtimeImage('ollama', 'amd'), 'ollama/ollama:rocm');
  assert.equal(runtimeImage('ollama', 'nvidia'), 'ollama/ollama:latest');
  assert.equal(runtimeImage('ollama', 'intel'), 'ollama/ollama:latest');
  assert.equal(runtimeImage('ollama', 'cpu'), 'ollama/ollama:latest');
});

test('runtimeImage: vLLM has a distinct build per vendor, CPU included', () => {
  assert.equal(runtimeImage('vllm', 'nvidia'), 'vllm/vllm-openai:latest');
  assert.equal(runtimeImage('vllm', 'amd'), 'rocm/vllm:latest');
  assert.equal(runtimeImage('vllm', 'intel'), 'intel/vllm:xpu');
  assert.equal(
    runtimeImage('vllm', 'cpu'),
    'public.ecr.aws/q9t5s3a7/vllm-cpu-release-repo:latest'
  );
});

test('runtimeImage: no two vendors of one runtime share an image by accident', () => {
  const vllm = new Set(
    (['nvidia', 'amd', 'intel', 'cpu'] as const).map(v =>
      runtimeImage('vllm', v)
    )
  );
  assert.equal(vllm.size, 4);
});

test('gpuComposeFragment: cpu needs no device passthrough', () => {
  assert.equal(gpuComposeFragment('cpu'), '');
});

test('gpuComposeFragment: nvidia reserves a GPU via the compose deploy spec', () => {
  const fragment = gpuComposeFragment('nvidia');
  assert.match(fragment, /driver: nvidia/);
  assert.match(fragment, /capabilities: \[gpu\]/);
});

test('gpuComposeFragment: amd passes through /dev/kfd and /dev/dri', () => {
  const fragment = gpuComposeFragment('amd');
  assert.match(fragment, /\/dev\/kfd/);
  assert.match(fragment, /\/dev\/dri/);
});

test('gpuComposeFragment: intel passes through /dev/dri', () => {
  assert.match(gpuComposeFragment('intel'), /\/dev\/dri/);
});

test('gpuComposeFragment: every line is indented for a compose service body', () => {
  for (const vendor of ['nvidia', 'amd', 'intel'] as const) {
    for (const line of gpuComposeFragment(vendor).split('\n').filter(Boolean)) {
      assert.match(line, /^ {4}\S|^ {6}/);
    }
  }
});
