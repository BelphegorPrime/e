/**
 * Central catalog of the environment variables the `e` CLI reads or sets.
 * Names, defaults, and parsing live here so call sites ask for a typed
 * value instead of matching a string against `process.env` themselves -
 * one place to see every variable this process is sensitive to.
 */
import { EGRESS_API_PORT } from '../egress/constants.js';
import { OMNIROUTE_PORT } from '../constants.js';
import { parseRunRole, type RunRole } from '../runs/runRole.js';

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
   * Set on an `e spawn` process started for a sibling request (ADR-0013): the
   * role its containers receive as `E_ROLE`. Deliberately not `E_ROLE` itself,
   * so a run's own container env never leaks into a nested `e spawn` as its
   * role. Unset means `parent`.
   */
  static readonly SPAWN_ROLE_VAR = 'E_SPAWN_ROLE';

  /**
   * Set together on an `e spawn` process the host starts for a sibling request
   * (ADR-0013): the parent run's worktree and branch (checkpointed and
   * branched from), its private network (absent in the shared egress
   * namespace), the parent's spool and the request id the sibling reports its
   * status under. All four required ones present, or none.
   */
  static readonly SPAWN_PARENT_WORKTREE_VAR = 'E_SPAWN_PARENT_WORKTREE';
  static readonly SPAWN_PARENT_BRANCH_VAR = 'E_SPAWN_PARENT_BRANCH';
  static readonly SPAWN_PARENT_NETWORK_VAR = 'E_SPAWN_PARENT_NETWORK';
  static readonly SPAWN_SPOOL_VAR = 'E_SPAWN_SPOOL';
  static readonly SPAWN_SIBLING_ID_VAR = 'E_SPAWN_SIBLING_ID';

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

  /**
   * The role this `e spawn` gives its containers (see {@link Env.SPAWN_ROLE_VAR}):
   * `parent` unless the marker says `child`. Throws on any other value.
   */
  get spawnRole(): RunRole {
    return parseRunRole(process.env[Env.SPAWN_ROLE_VAR], Env.SPAWN_ROLE_VAR);
  }

  /**
   * The sibling markers of this `e spawn` process (see {@link Env.SPAWN_SPOOL_VAR}),
   * or undefined for an ordinary spawn. Throws when only some are set.
   */
  get sibling(): SiblingSpawn | undefined {
    const read = (name: string) => process.env[name]?.trim() || undefined;
    const worktreePath = read(Env.SPAWN_PARENT_WORKTREE_VAR);
    const branch = read(Env.SPAWN_PARENT_BRANCH_VAR);
    const spoolDir = read(Env.SPAWN_SPOOL_VAR);
    const id = read(Env.SPAWN_SIBLING_ID_VAR);
    const present = [worktreePath, branch, spoolDir, id].filter(
      value => value !== undefined
    ).length;
    if (present === 0) return undefined;
    if (present < 4 || !worktreePath || !branch || !spoolDir || !id) {
      throw new Error(
        `Incomplete sibling markers: ${Env.SPAWN_PARENT_WORKTREE_VAR}, ${Env.SPAWN_PARENT_BRANCH_VAR}, ${Env.SPAWN_SPOOL_VAR} and ${Env.SPAWN_SIBLING_ID_VAR} must all be set.`
      );
    }
    return {
      parent: {
        worktreePath,
        branch,
        network: read(Env.SPAWN_PARENT_NETWORK_VAR),
      },
      spoolDir,
      id,
    };
  }

  /**
   * Copies `base` (defaulting to the current environment) for a sibling `e
   * spawn` process: the role marker says `child`, the sibling markers are set,
   * and the serve/terminal markers are dropped so the sibling never mistakes
   * itself for one of those.
   */
  withSibling(
    sibling: SiblingSpawn,
    base: Record<string, string | undefined> = process.env
  ): Record<string, string | undefined> {
    const copy: Record<string, string | undefined> = { ...base };
    delete copy[Env.SERVE_DETACHED_VAR];
    delete copy[Env.TTY_HEADLESS_VAR];
    copy[Env.SPAWN_ROLE_VAR] = 'child';
    copy[Env.SPAWN_PARENT_WORKTREE_VAR] = sibling.parent.worktreePath;
    copy[Env.SPAWN_PARENT_BRANCH_VAR] = sibling.parent.branch;
    if (sibling.parent.network) {
      copy[Env.SPAWN_PARENT_NETWORK_VAR] = sibling.parent.network;
    } else {
      delete copy[Env.SPAWN_PARENT_NETWORK_VAR];
    }
    copy[Env.SPAWN_SPOOL_VAR] = sibling.spoolDir;
    copy[Env.SPAWN_SIBLING_ID_VAR] = sibling.id;
    return copy;
  }
}

/** What the sibling markers describe: the parent run and where to report. */
export interface SiblingSpawn {
  parent: {
    /** Host path of the parent's worktree. */
    worktreePath: string;
    /** The parent's run branch. */
    branch: string;
    /** The parent's private run network to join; absent in the shared egress namespace. */
    network?: string;
  };
  /** The parent's spool (the broker's bind mount). */
  spoolDir: string;
  /** The request id (`sib-NNN`) this sibling reports its status under. */
  id: string;
}

export const env = new Env();
