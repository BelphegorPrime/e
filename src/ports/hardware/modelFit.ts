import type { LocalRuntime } from '../../core/localRuntimes.js';
import type { ModelCatalogEntry } from '../../core/modelStatus.js';
import type { HardwareProfile } from './profile.js';

/**
 * Where a catalog model's weights can live on the detected hardware:
 *
 * - `gpu` - weights and KV cache fit the GPU pool (dedicated VRAM, or the
 *   unified pool on an Apple Silicon / iGPU host). The ideal case.
 * - `gpu-moe` - a Mixture-of-Experts model whose *active* parameters fit the
 *   GPU pool while the idle experts stream from system RAM. Usable, because
 *   only the active share is touched per token.
 * - `host` - too big for the GPU, but it fits in system RAM; CPU inference.
 * - `too-large` - it fits nowhere, so `e init` does not offer it.
 */
export type ModelFit = 'gpu' | 'gpu-moe' | 'host' | 'too-large';

/**
 * Bytes to reserve on top of the weights for the KV cache and runtime scratch.
 * A catalog's `sizeBytes` is the download size - quantized weights only - and
 * the stack runs llama.cpp with a 32k context (`LLAMA_ARG_CTX_SIZE`), which
 * costs roughly this much on a model of the sizes offered here.
 */
const KV_RESERVE_BYTES = 1.5 * 1024 ** 3;

/** Share of dedicated VRAM usable for weights; the rest is driver and framebuffer. */
const DEDICATED_VRAM_USABLE = 0.9;

/**
 * Share of a unified pool a GPU may claim. Both macOS (Metal's default
 * `iogpu.wired_limit`) and Linux iGPU drivers cap GPU-wired memory well below
 * the physical total, and the OS still needs the remainder.
 */
const UNIFIED_MEMORY_USABLE = 0.75;

/**
 * Share of system RAM usable for model weights. The rest of the local stack -
 * OmniRoute, Redis, Searxng, the egress monitor and the agent container -
 * runs on the same host.
 */
const HOST_MEMORY_USABLE = 0.8;

/** Bytes the GPU can hold weights in: dedicated VRAM, or the unified pool. */
export function gpuPoolBytes(profile: HardwareProfile): number {
  if (profile.unifiedMemory) {
    return profile.totalMemoryBytes * UNIFIED_MEMORY_USABLE;
  }
  return profile.totalVramBytes * DEDICATED_VRAM_USABLE;
}

/** Bytes of system memory available for weights or expert offload. */
export function hostPoolBytes(profile: HardwareProfile): number {
  return profile.totalMemoryBytes * HOST_MEMORY_USABLE;
}

/** A model is MoE when fewer parameters are active per token than it holds. */
export function isMixtureOfExperts(model: ModelCatalogEntry): boolean {
  return model.activeParamsB < model.paramsB;
}

/**
 * The weight bytes an MoE keeps hot: its download size scaled by the active
 * parameter share. A dense model keeps all of them, so this is its full size.
 */
export function activeWeightBytes(model: ModelCatalogEntry): number {
  if (model.paramsB <= 0) return model.sizeBytes;
  return model.sizeBytes * (model.activeParamsB / model.paramsB);
}

/** Decides where `model` can run on `profile`, purely. */
export function classifyModelFit(
  model: ModelCatalogEntry,
  profile: HardwareProfile
): ModelFit {
  const needed = model.sizeBytes + KV_RESERVE_BYTES;
  const gpu = gpuPoolBytes(profile);
  const host = hostPoolBytes(profile);

  if (gpu > 0 && needed <= gpu) return 'gpu';
  // Offloading idle experts only buys something when the two pools are
  // physically distinct; on a unified host they are the same memory.
  if (gpu > 0 && !profile.unifiedMemory && isMixtureOfExperts(model)) {
    const hot = activeWeightBytes(model) + KV_RESERVE_BYTES;
    if (hot <= gpu && needed <= gpu + host) return 'gpu-moe';
  }
  if (needed <= host) return 'host';
  return 'too-large';
}

/** Best fit first; `too-large` last, where only a kept selection can appear. */
const FIT_RANK: Readonly<Record<ModelFit, number>> = {
  gpu: 0,
  'gpu-moe': 1,
  host: 2,
  'too-large': 3,
};

/**
 * The models `e init` should offer for `profile`: everything that fits
 * somewhere, best fit first. `keep` names ids to offer regardless of fit - the
 * already-configured selection, which a re-init must still be able to show
 * and untick even after a hardware change.
 */
export function affordableModels(
  catalog: readonly ModelCatalogEntry[],
  profile: HardwareProfile,
  keep: readonly string[] = []
): ModelCatalogEntry[] {
  return catalog
    .map(entry => ({ entry, fit: classifyModelFit(entry, profile) }))
    .filter(rated => rated.fit !== 'too-large' || keep.includes(rated.entry.id))
    .sort((a, b) => FIT_RANK[a.fit] - FIT_RANK[b.fit])
    .map(rated => rated.entry);
}

/** {@link affordableModels} applied to every runtime's catalog. */
export function affordableCatalogs(
  catalogs: Readonly<Record<LocalRuntime, readonly ModelCatalogEntry[]>>,
  profile: HardwareProfile,
  keep: readonly string[] = []
): Record<LocalRuntime, readonly ModelCatalogEntry[]> {
  const filtered = {} as Record<LocalRuntime, readonly ModelCatalogEntry[]>;
  for (const [runtime, catalog] of Object.entries(catalogs) as [
    LocalRuntime,
    readonly ModelCatalogEntry[],
  ][]) {
    filtered[runtime] = affordableModels(catalog, profile, keep);
  }
  return filtered;
}

/** Formats a billions-of-parameters figure without a pointless `.0`. */
function formatParams(billions: number): string {
  return Number.isInteger(billions) ? `${billions}` : billions.toFixed(1);
}

/** A short hint for the `e init` model list saying why a model is offered. */
export function describeModelFit(
  model: ModelCatalogEntry,
  profile: HardwareProfile
): string {
  switch (classifyModelFit(model, profile)) {
    case 'gpu':
      return profile.unifiedMemory ? 'fits unified memory' : 'fits VRAM';
    case 'gpu-moe':
      return `MoE, ${formatParams(model.activeParamsB)}B active in VRAM`;
    case 'host':
      return 'RAM only, CPU inference';
    case 'too-large':
      return 'exceeds detected memory';
  }
}
