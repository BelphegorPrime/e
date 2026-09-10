/**
 * Central catalog of the environment variables the `e` CLI reads or sets.
 * Names, defaults, and parsing live here so call sites ask for a typed
 * value instead of matching a string against `process.env` themselves —
 * one place to see every variable this process is sensitive to.
 */
export class Env {
  /** Set on the detached `serve` child so it can recognize itself on restart. */
  static readonly SERVE_DETACHED_VAR = 'E_SERVE_DETACHED';

  /** Host-published base URL of the local llama.cpp router (see `renderCompose`). */
  get localLlamaUrl(): string {
    return process.env.LOCAL_LLAMA_URL ?? 'http://127.0.0.1:9931';
  }

  /** Whether `log` should mirror every line to `log.txt` in the working directory. */
  get shouldWriteLogFile(): boolean {
    return process.env.SHOULD_WRITE_LOG_FILE === 'true';
  }

  /** True when running inside the detached `serve` child spawned by `startDetachedServe`. */
  get serveDetached(): boolean {
    return process.env[Env.SERVE_DETACHED_VAR] === '1';
  }

  /** Copies `base` (defaulting to the current environment) with the detached-serve marker set. */
  withServeDetached(
    base: Record<string, string | undefined> = process.env
  ): Record<string, string | undefined> {
    return { ...base, [Env.SERVE_DETACHED_VAR]: '1' };
  }
}

export const env = new Env();
