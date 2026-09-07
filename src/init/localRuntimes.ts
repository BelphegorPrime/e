import type { ModelCatalogEntry } from '../modelStatus.js';
import { MODEL_CATALOG } from '../modelStatus.js';

/**
 * Local AI runtimes which `e init` can provision.  Add a definition here (plus
 * a catalog entry in {@link RUNTIME_CATALOGS} and a compose/bootstrap
 * contribution in the renderers) and the init decision flow stays a generic
 * multi-select.
 */
export const LOCAL_RUNTIMES = [
  { id: 'llamacpp', label: 'llama.cpp' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'vllm', label: 'vLLM' },
] as const;

export type LocalRuntime = (typeof LOCAL_RUNTIMES)[number]['id'];

export function isLocalRuntime(value: unknown): value is LocalRuntime {
  return (
    typeof value === 'string' &&
    LOCAL_RUNTIMES.some(runtime => runtime.id === value)
  );
}

/** Models `e init` offers for llama.cpp (Hugging Face GGUF ids). */
export const LLAMACPP_CATALOG: readonly ModelCatalogEntry[] = MODEL_CATALOG;

/** Models `e init` offers for Ollama (`model:tag` registry ids). */
export const OLLAMA_CATALOG: readonly ModelCatalogEntry[] = [
  { id: 'qwen3:4b', sizeBytes: 2_500_000_000 },
  { id: 'llama3.2:3b', sizeBytes: 2_000_000_000 },
  { id: 'gemma3:4b', sizeBytes: 3_300_000_000 },
];

/** Models `e init` offers for vLLM (Hugging Face ids, OpenAI-compatible). */
export const VLLM_CATALOG: readonly ModelCatalogEntry[] = [
  { id: 'Qwen/Qwen2.5-7B-Instruct', sizeBytes: 15_000_000_000 },
  { id: 'meta-llama/Llama-3.1-8B-Instruct', sizeBytes: 16_000_000_000 },
];

/** Every runtime's offerable model catalog, keyed by runtime id. */
export const RUNTIME_CATALOGS: Readonly<
  Record<LocalRuntime, readonly ModelCatalogEntry[]>
> = {
  llamacpp: LLAMACPP_CATALOG,
  ollama: OLLAMA_CATALOG,
  vllm: VLLM_CATALOG,
};

/**
 * Merges the model catalogs of the selected runtimes, deduplicated by id and
 * in runtime order. The wizard shows exactly this selection when asking which
 * models to keep, so a model prompt answer stays index-aligned with the list
 * the user saw.
 */
export function composeModelCatalog(
  runtimes: readonly LocalRuntime[],
  catalogs: Readonly<Record<LocalRuntime, readonly ModelCatalogEntry[]>> =
    RUNTIME_CATALOGS
): ModelCatalogEntry[] {
  const seen = new Set<string>();
  const merged: ModelCatalogEntry[] = [];
  for (const runtime of runtimes) {
    for (const entry of catalogs[runtime] ?? []) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        merged.push(entry);
      }
    }
  }
  return merged;
}