/**
 * Central catalog of the environment variables the `e` CLI reads or sets.
 * Names, defaults, and parsing live here so call sites ask for a typed
 * value instead of matching a string against `process.env` themselves -
 * one place to see every variable this process is sensitive to. The few
 * host-process facts the CLI decides on next to its variables (whether stdin
 * is a terminal) live here too, so every edge reads them from one place.
 */
import { EGRESS_API_PORT, OMNIROUTE_PORT } from '../constants.js';
import { parseRunRole, type RunRole } from '../runRole.js';

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
   * Set together on an `e spawn` process something else watches (the A2A
   * facade of `e serve`, ADR-0015): a spool and the request id the run
   * reports its status under. Unlike the sibling markers they change nothing
   * else about the run (it pushes and opens its PR/MR as usual). Both or none.
   */
  static readonly SPAWN_REPORT_SPOOL_VAR = 'E_SPAWN_REPORT_SPOOL';
  static readonly SPAWN_REPORT_ID_VAR = 'E_SPAWN_REPORT_ID';
  /**
   * The ledger entry (`.e/runs/live/<id>.json`) an `e spawn` started by `e
   * serve`'s queue reports into (ADR-0016 section 6): `serve` claimed it and
   * holds its slot, so the run patches that entry rather than writing its own.
   * Never inherited by a sibling or a watched child, which are runs of their own.
   */
  static readonly LEDGER_FILE_VAR = 'E_LEDGER_FILE';

  /**
   * Set together on an `e spawn` a triggered run started - by `e serve`'s
   * queue, or a triggered run's sibling (ADR-0016 section 9): the trigger's
   * id, the `E-Event` value and, optionally, the event's page. Every commit
   * that run writes carries them as trailers. Validated where the request was
   * accepted; stripped from a run of the user's own, which carries none.
   */
  static readonly TRIGGER_VAR = 'E_TRIGGER';
  static readonly EVENT_VAR = 'E_EVENT';
  static readonly EVENT_URL_VAR = 'E_EVENT_URL';

  /**
   * The file an `e spawn` reads in place of its Store's `.env`: set by a
   * one-shot run (ADR-0016 section 13) on each sibling it starts, whose
   * `--dir` is the Base Store, so the sibling's secrets come from the same
   * `--env-file` as its parent's and never from a `.env` in any `.e/`.
   * Passed on to a sibling, never to a run of its own.
   */
  static readonly STORE_ENV_FILE_VAR = 'E_STORE_ENV_FILE';

  /**
   * The bearer token `e serve` requires on its A2A endpoint (ADR-0015). Unset,
   * the endpoint is open on loopback only; a `serve` bound beyond loopback
   * without a token disables the endpoint rather than expose it.
   */
  static readonly A2A_TOKEN_VAR = 'E_A2A_TOKEN';

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

  /**
   * Set by GitHub Actions to the name of the event that started the workflow
   * - the name `e spawn --trigger --event "$GITHUB_EVENT_PATH"` matches `on`
   * against when `--event-name` is not given (ADR-0016 section 13).
   */
  static readonly GITHUB_EVENT_NAME_VAR = 'GITHUB_EVENT_NAME';

  /**
   * Set by GitHub Actions about the job itself: what a one-shot run's
   * `E-Event` names (`workflow:<name>:<run id>`) and links in its PR block
   * (ADR-0016 section 9). Validated where they are read into provenance.
   */
  static readonly GITHUB_WORKFLOW_VAR = 'GITHUB_WORKFLOW';
  static readonly GITHUB_RUN_ID_VAR = 'GITHUB_RUN_ID';
  static readonly GITHUB_SERVER_URL_VAR = 'GITHUB_SERVER_URL';
  static readonly GITHUB_REPOSITORY_VAR = 'GITHUB_REPOSITORY';

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

  /**
   * True when the host process has a terminal on stdin: the one thing an
   * interactive run (the harness TUI) needs and a pipe or CI job lacks.
   */
  get stdinIsTty(): boolean {
    return Boolean(process.stdin.isTTY);
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
   * The report markers of this `e spawn` process (see {@link Env.SPAWN_REPORT_SPOOL_VAR}),
   * or undefined for a run nothing watches. Throws when only one is set.
   */
  get report(): { spoolDir: string; id: string } | undefined {
    const spoolDir =
      process.env[Env.SPAWN_REPORT_SPOOL_VAR]?.trim() || undefined;
    const id = process.env[Env.SPAWN_REPORT_ID_VAR]?.trim() || undefined;
    if (spoolDir === undefined && id === undefined) return undefined;
    if (spoolDir === undefined || id === undefined) {
      throw new Error(
        `Incomplete report markers: ${Env.SPAWN_REPORT_SPOOL_VAR} and ${Env.SPAWN_REPORT_ID_VAR} must both be set.`
      );
    }
    return { spoolDir, id };
  }

  /**
   * Copies `base` for an `e spawn` child that reports into a spool without
   * being a sibling (the A2A facade): the report markers set, the serve,
   * terminal and sibling markers and a stand-in `.env` dropped.
   */
  withReport(
    report: { spoolDir: string; id: string },
    base: Record<string, string | undefined> = process.env
  ): Record<string, string | undefined> {
    const copy: Record<string, string | undefined> = { ...base };
    for (const name of [
      Env.SERVE_DETACHED_VAR,
      Env.TTY_HEADLESS_VAR,
      Env.SPAWN_ROLE_VAR,
      Env.SPAWN_PARENT_WORKTREE_VAR,
      Env.SPAWN_PARENT_BRANCH_VAR,
      Env.SPAWN_PARENT_NETWORK_VAR,
      Env.SPAWN_SPOOL_VAR,
      Env.SPAWN_SIBLING_ID_VAR,
      Env.LEDGER_FILE_VAR,
      Env.STORE_ENV_FILE_VAR,
      ...PROVENANCE_VARS,
    ]) {
      delete copy[name];
    }
    copy[Env.SPAWN_REPORT_SPOOL_VAR] = report.spoolDir;
    copy[Env.SPAWN_REPORT_ID_VAR] = report.id;
    return copy;
  }

  /** The Actions event name (see {@link Env.GITHUB_EVENT_NAME_VAR}), or undefined when unset or blank. */
  get githubEventName(): string | undefined {
    return process.env[Env.GITHUB_EVENT_NAME_VAR]?.trim() || undefined;
  }

  /** The file standing in for the Store's `.env` (see {@link Env.STORE_ENV_FILE_VAR}), or undefined. */
  get storeEnvFile(): string | undefined {
    return process.env[Env.STORE_ENV_FILE_VAR]?.trim() || undefined;
  }

  /** What GitHub Actions says about the running job (see {@link Env.GITHUB_WORKFLOW_VAR}); blank reads as unset. */
  get githubWorkflowRun(): {
    workflow?: string;
    runId?: string;
    serverUrl?: string;
    repository?: string;
  } {
    const read = (name: string) => process.env[name]?.trim() || undefined;
    const facts = {
      workflow: read(Env.GITHUB_WORKFLOW_VAR),
      runId: read(Env.GITHUB_RUN_ID_VAR),
      serverUrl: read(Env.GITHUB_SERVER_URL_VAR),
      repository: read(Env.GITHUB_REPOSITORY_VAR),
    };
    return Object.fromEntries(
      Object.entries(facts).filter(([, value]) => value !== undefined)
    );
  }

  /** The claimed ledger entry this `e spawn` reports into (see {@link Env.LEDGER_FILE_VAR}), or undefined. */
  get ledgerFile(): string | undefined {
    return process.env[Env.LEDGER_FILE_VAR]?.trim() || undefined;
  }

  /**
   * Copies `base` for the `e spawn` child of a claimed queue request: the
   * ledger marker set, every serve, terminal, sibling and report marker
   * dropped - it is a run of the user's own, just not started by one.
   */
  withLedger(
    file: string,
    base: Record<string, string | undefined> = process.env
  ): Record<string, string | undefined> {
    const copy = this.withReport({ spoolDir: '', id: '' }, base);
    delete copy[Env.SPAWN_REPORT_SPOOL_VAR];
    delete copy[Env.SPAWN_REPORT_ID_VAR];
    copy[Env.LEDGER_FILE_VAR] = file;
    return copy;
  }

  /**
   * The provenance markers (see {@link Env.TRIGGER_VAR}), unparsed; undefined
   * when none is set. The trigger and the event come together or not at all.
   */
  get provenance(): ProvenanceVars | undefined {
    const read = (name: string) => process.env[name]?.trim() || undefined;
    const trigger = read(Env.TRIGGER_VAR);
    const event = read(Env.EVENT_VAR);
    const url = read(Env.EVENT_URL_VAR);
    if (trigger === undefined && event === undefined) return undefined;
    if (trigger === undefined || event === undefined) {
      throw new Error(
        `Incomplete provenance markers: ${Env.TRIGGER_VAR} and ${Env.EVENT_VAR} must both be set.`
      );
    }
    return { trigger, event, ...(url !== undefined ? { url } : {}) };
  }

  /** The provenance markers for a child process's environment. */
  provenanceEnv(vars: ProvenanceVars): Record<string, string> {
    return {
      [Env.TRIGGER_VAR]: vars.trigger,
      [Env.EVENT_VAR]: vars.event,
      ...(vars.url !== undefined ? { [Env.EVENT_URL_VAR]: vars.url } : {}),
    };
  }

  /** The `E_A2A_TOKEN` bearer token for `e serve`'s A2A endpoint, or undefined when unset or blank. */
  get a2aToken(): string | undefined {
    const value = process.env[Env.A2A_TOKEN_VAR]?.trim();
    return value ? value : undefined;
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
    delete copy[Env.SPAWN_REPORT_SPOOL_VAR];
    delete copy[Env.SPAWN_REPORT_ID_VAR];
    delete copy[Env.LEDGER_FILE_VAR];
    // A sibling inherits its parent's provenance explicitly, never a stale
    // marker from the environment around it.
    for (const name of PROVENANCE_VARS) delete copy[name];
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

/** The provenance markers as the environment carries them: the trigger, the `E-Event` value, the event's page. */
export interface ProvenanceVars {
  trigger: string;
  event: string;
  url?: string;
}

const PROVENANCE_VARS = [
  Env.TRIGGER_VAR,
  Env.EVENT_VAR,
  Env.EVENT_URL_VAR,
] as const;

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
