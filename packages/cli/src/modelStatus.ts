import { log } from './utils/log';

/** Host-published base URL of the local llama.cpp router (see `renderCompose`). */
export const LOCAL_LLAMA_URL =
  process.env.LOCAL_LLAMA_URL ?? 'http://127.0.0.1:9931';

/** A locally-provisionable llama.cpp model, with its approximate download size. */
export interface ModelCatalogEntry {
  id: string;
  /** Approximate download size in bytes — shown during `e init` selection. */
  sizeBytes: number;
}

/** Models `e init` offers to provision locally, in preference order — first is the default. */
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: 'unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M',
    sizeBytes: 16_500_000_000,
  },
  {
    id: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS',
    sizeBytes: 17_700_000_000,
  },
  {
    id: 'ornith-ai/Ornith-1.5-35B-A3B-GGUF:Q4_K_M',
    sizeBytes: 21_000_000_000,
  },
];

/** All catalog model ids, selected by default when a user hasn't chosen otherwise. */
export const MODELS = MODEL_CATALOG.map(m => m.id);
export const DEFAULT_MODEL = MODELS[0];

export type ModelStatusValue =
  'unloaded' | 'loading' | 'loaded' | 'downloading' | 'sleeping';

/** Per-file download progress, keyed by source URL (llama.cpp downloads shards in parallel). */
export interface DownloadProgress {
  [url: string]: { done: number; total: number };
}

export interface ModelStatus {
  value: ModelStatusValue;
  failed?: boolean;
  progress?: DownloadProgress;
}

export interface ModelEntry {
  id: string;
  status: ModelStatus;
}

export interface ModelsResponse {
  data: ModelEntry[];
}

/** Formats a byte count as a human-readable size, e.g. `186.9 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** Formats a millisecond duration as a human-readable estimate, e.g. `2m 30s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/** Sums the `done`/`total` bytes of every file a model is currently downloading. */
function totalProgress(progress: DownloadProgress): {
  done: number;
  total: number;
} {
  let done = 0;
  let total = 0;
  for (const file of Object.values(progress)) {
    done += file.done;
    total += file.total;
  }
  return { done, total };
}

/** A model is usable once it has loaded; `sleeping` means it loaded and then idled out. */
export function isModelReady(status: ModelStatus | undefined): boolean {
  return status?.value === 'loaded' || status?.value === 'sleeping';
}

/** Tracks a model's downloaded-bytes over time, to derive transfer speed and an ETA. */
export interface ProgressSample {
  bytes: number;
  atMs: number;
}

/**
 * Renders one status line per requested model and reports whether one model
 * is ready. Pure and side-effect free so it's testable without a real server;
 * `history` is mutated in place to remember each model's last sample for speed/ETA.
 */
export function describeModels(
  response: ModelsResponse,
  models: string[],
  history: Map<string, ProgressSample>,
  nowMs: number
): { lines: string[]; ready: boolean; failed: string[] } {
  const lines: string[] = [];
  const failed: string[] = [];
  let ready = false;

  for (const id of models) {
    const entry = response.data.find(d => d.id === id);
    const status = entry?.status;

    if (status?.failed) {
      failed.push(id);
      lines.push(`${id}: failed to load`);
      continue;
    }

    if (!status || status.value === 'unloaded') {
      lines.push(`${id}: waiting to start`);
      continue;
    }

    if (status.value === 'downloading' && status.progress) {
      const { done, total } = totalProgress(status.progress);
      const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
      const prev = history.get(id);
      history.set(id, { bytes: done, atMs: nowMs });

      let eta = 'estimating...';
      if (prev && nowMs > prev.atMs) {
        const bytesPerSecond =
          (done - prev.bytes) / ((nowMs - prev.atMs) / 1000);
        if (bytesPerSecond > 0) {
          eta = `~${formatDuration(((total - done) / bytesPerSecond) * 1000)} remaining`;
        }
      }
      lines.push(
        `${id}: downloading ${pct}% (${formatBytes(done)} / ${formatBytes(total)}) — ${eta}`
      );
      continue;
    }

    if (status.value === 'loading') {
      lines.push(`${id}: loading into memory...`);
      continue;
    }

    if (isModelReady(status)) {
      ready = true;
    }

    lines.push(`${id}: ready (${status.value})`);
  }

  return { lines, ready: ready && failed.length < models.length, failed };
}

export interface WaitForModelsReadyOptions {
  /** Base URL of the llama.cpp router, e.g. `http://127.0.0.1:9931`. */
  baseUrl: string;
  models: string[];
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  now?: () => number;
  onLine?: (line: string) => void;
}

/**
 * Polls llama.cpp's `/models` endpoint until at least one requested model has
 * finished downloading and loading, printing download progress and an ETA
 * along the way. Throws if any model reports a load failure.
 */
export async function waitForModelsReady(
  opts: WaitForModelsReadyOptions
): Promise<void> {
  const {
    baseUrl,
    models,
    fetchImpl = fetch,
    sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    pollIntervalMs = 2000,
    now = Date.now,
    onLine = log.info,
  } = opts;

  onLine('Waiting for models to finish downloading and loading...');
  const history = new Map<string, ProgressSample>();
  let lastPrinted = '';

  for (;;) {
    const res = await fetchImpl(`${baseUrl}/models`);
    if (!res.ok) {
      throw new Error(`Failed to query model status (HTTP ${res.status}).`);
    }
    const body = (await res.json()) as ModelsResponse;
    const { lines, ready, failed } = describeModels(
      body,
      models,
      history,
      now()
    );

    if (failed.length > 0) {
      throw new Error(`Model(s) failed to load: ${failed.join(', ')}`);
    }

    const rendered = lines.join('\n');
    if (rendered !== lastPrinted) {
      onLine(rendered);
      lastPrinted = rendered;
    }

    if (ready) {
      onLine('At least one model is ready.');
      return;
    }

    await sleep(pollIntervalMs);
  }
}
