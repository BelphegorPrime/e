/**
 * Central catalog of the environment variables the `e` CLI reads or sets.
 * Names, defaults, and parsing live here so call sites ask for a typed
 * value instead of matching a string against `process.env` themselves -
 * one place to see every variable this process is sensitive to.
 */
import { EGRESS_API_PORT } from '../egress/constants.js';
import { OMNIROUTE_PORT } from '../constants.js';

export class Env {
  /** Set on the detached `serve` child so it can recognize itself on restart. */
  static readonly SERVE_DETACHED_VAR = 'E_SERVE_DETACHED';

  /**
   * Set on an `e spawn` child that has no host TTY to attach to (the browser
   * terminal started by `e serve`): the run allocates its TTY inside the
   * container and the parent attaches through the container engine's API.
   */
  static readonly TTY_HEADLESS_VAR = 'E_TTY_HEADLESS';

  /**
   * The container runtime to use when `--runtime` is not passed - one of the
   * registry names (`docker`, `podman`, `nerdctl`, `finch`; see
   * `runtime/registry.ts`). Unset: the first one found on `PATH`.
   */
  static readonly RUNTIME_VAR = 'E_RUNTIME';

  /**
   * Where run worktrees are created. Must be a path the container engine can
   * bind-mount - on macOS/Windows that means a path shared into the engine's
   * VM. Unset: a platform default (see `runs/worktreesDir.ts`).
   */
  static readonly WORKTREES_DIR_VAR = 'E_WORKTREES_DIR';

  /** Host-published base URL of the local llama.cpp router (see `renderCompose`). */
  get localLlamaUrl(): string {
    return process.env.LOCAL_LLAMA_URL ?? 'http://127.0.0.1:9931';
  }

  /** Host-published base URL of the egress container HTTP API (ADR-0012). */
  get egressApiUrl(): string {
    return process.env.EGRESS_API_URL ?? `http://127.0.0.1:${EGRESS_API_PORT}`;
  }

  /** Host-published base URL of the OmniRoute dashboard (see `renderCompose`). */
  get omniRoutedUrl(): string {
    return process.env.OMNIROUTE_URL ?? `http://127.0.0.1:${OMNIROUTE_PORT}`;
  }

  /** The `E_RUNTIME` runtime name, or undefined when unset or blank. */
  get runtime(): string | undefined {
    const value = process.env[Env.RUNTIME_VAR]?.trim();
    return value ? value : undefined;
  }

  /** The `E_WORKTREES_DIR` override, or undefined when unset or blank. */
  get worktreesDir(): string | undefined {
    const value = process.env[Env.WORKTREES_DIR_VAR]?.trim();
    return value ? value : undefined;
  }

  /** Whether `log` should mirror every line to `log.txt` in the working directory. */
  get shouldWriteLogFile(): boolean {
    return process.env.SHOULD_WRITE_LOG_FILE === 'true';
  }

  /** Whether verbose logging is enabled. */
  get verbose(): boolean {
    return process.env.VERBOSE === 'true';
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

  /** True when this `e spawn` runs without a host TTY and must detach the container's TTY (see {@link Env.TTY_HEADLESS_VAR}). */
  get headlessTty(): boolean {
    return process.env[Env.TTY_HEADLESS_VAR] === '1';
  }

  /**
   * Copies `base` for a headless `e spawn` child: the headless-TTY marker set
   * and the detached-serve marker dropped, so the child never mistakes itself
   * for a `serve` process.
   */
  withHeadlessTty(
    base: Record<string, string | undefined> = process.env
  ): Record<string, string | undefined> {
    const copy: Record<string, string | undefined> = { ...base };
    delete copy[Env.SERVE_DETACHED_VAR];
    copy[Env.TTY_HEADLESS_VAR] = '1';
    return copy;
  }
}

export const env = new Env();
