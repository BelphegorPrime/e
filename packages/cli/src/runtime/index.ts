import { spawn, spawnSync } from 'child_process';
import { log } from '../utils/log';

/**
 * A bind mount as structured data, so callers describe *what* to mount and the
 * runtime owns the `host:container[:ro]` argv format (rather than each caller
 * hand-concatenating the string). `ro` defaults to read-write when omitted.
 */
export interface Mount {
  /** Host path to mount. */
  host: string;
  /** Container path it appears at. */
  container: string;
  /** Mount read-only (`:ro`); omit or false for read-write. */
  ro?: boolean;
}

/** Formats a {@link Mount} into the runtime's `-v host:container[:ro]` value. */
export function formatMount(m: Mount): string {
  return m.ro ? `${m.host}:${m.container}:ro` : `${m.host}:${m.container}`;
}

export interface RunOptions {
  name?: string;
  attach?: boolean;
  port?: string[];
  env?: string[];
  rm?: boolean;
  rmWorktree?: boolean;
  /** Bind mounts. */
  volumes?: Mount[];
  /** Working directory inside the container (-w). */
  workdir?: string;
  /**
   * Env files loaded into the container (--env-file), in order. Later files
   * override earlier ones for the same key; `-e` vars override all of them.
   */
  envFile?: string[];
  /**
   * Private network to attach the container to (`--network`). The primary agent
   * joins its Run's network so it can reach sidecars by their alias; a bare run
   * (no sidecars) leaves this unset and uses the default bridge as before.
   */
  network?: string;
  /** Hostname mappings added to the container (`--add-host`). */
  extraHosts?: string[];
}

/**
 * A **Sidecar** to bring up alongside the primary agent (ADR-0005): a
 * container-transport MCP server on the Run's private network. The `name` is
 * unique per run (so concurrent runs never collide); the `alias` is the stable
 * short name the agent reaches it by (`http://<alias>:<port>/mcp`).
 */
export interface SidecarSpec {
  /** Unique per-run container name, e.g. `<runName>-mcp-everything`. */
  name: string;
  /** Stable network alias the agent uses in the endpoint URL, e.g. `everything`. */
  alias: string;
  /** The sidecar's image tag (built from `.e/mcp/<name>/Dockerfile`). */
  image: string;
  /** Private network the sidecar joins. */
  network: string;
  /** TCP port the sidecar listens on — probed for readiness, reached by the agent. */
  port: number;
  /** Optional in-container readiness command; readiness also requires it to exit 0. */
  healthcheck?: string[];
  /** Env files delivering the sidecar's own credentials (never the agent's). */
  envFile?: string[];
}

/**
 * The run surface the orchestrator depends on. Kept minimal so a fake can
 * stand in for a real runtime in tests. ADR-0005 grows it from "run one
 * container" to "bring up a group, wait on the primary, tear all down": the
 * network/sidecar/probe primitives below compose a Run's group, while `run`
 * still executes the primary agent in the foreground.
 */
export interface ContainerRunner {
  /** Runs the primary agent container in the foreground; resolves with its exit code. */
  run(image: string, opts: RunOptions, commandArgs: string[]): Promise<number>;

  /** Create a private container network. Throws on failure. */
  createNetwork(name: string): void;
  /**
   * Remove a network. Best-effort: never throws — it runs in teardown, where a
   * failure must not mask the Run's result.
   */
  removeNetwork(name: string): void;

  /** Start a sidecar detached on its network (with its alias). Throws if it fails to start. */
  startSidecar(spec: SidecarSpec): void;
  /** Stop and remove a container by name. Best-effort: never throws (teardown). */
  removeContainer(name: string): void;

  /**
   * True if a TCP connection to `port` on `host` succeeds, probed from a sibling
   * container on `network` — the sidecar publishes no host port, so readiness is
   * checked over the same private-network DNS the agent will use.
   */
  probeTcp(network: string, host: string, port: number): boolean;
  /** Run `command` inside `container` (`exec`); true iff it exits 0. */
  probeHealthcheck(container: string, command: string[]): boolean;
  /** True if the named container is still running — used to detect a mid-run crash. */
  isRunning(name: string): boolean;
}

/**
 * Pure argv builders — one per runtime subcommand. Each returns the arguments
 * that follow the runtime executable, so the corresponding method reduces to
 * `spawnSync(this.command, xArgs(...))`. Extracted so every subcommand's argv is
 * assertable without spawning a process (only `run`'s builder, {@link
 * ContainerRuntime.buildRunArgs}, used to be reachable by a test).
 */
export function versionArgs(): string[] {
  return ['--version'];
}

export function imageInspectArgs(imageTag: string): string[] {
  return ['image', 'inspect', imageTag];
}

export function buildImageArgs(
  imageTag: string,
  contextDir: string,
  dockerfile?: string
): string[] {
  const args = ['build', '-t', imageTag];
  if (dockerfile) args.push('-f', dockerfile);
  args.push(contextDir);
  return args;
}

export function networkCreateArgs(name: string): string[] {
  return ['network', 'create', name];
}

export function networkRemoveArgs(name: string): string[] {
  return ['network', 'rm', name];
}

export function sidecarRunArgs(spec: SidecarSpec): string[] {
  const args = [
    'run',
    '-d',
    '--name',
    spec.name,
    '--network',
    spec.network,
    '--network-alias',
    spec.alias,
  ];
  for (const f of spec.envFile ?? []) args.push('--env-file', f);
  args.push(spec.image);
  return args;
}

export function containerRemoveArgs(name: string): string[] {
  return ['rm', '-f', name];
}

export function tcpProbeArgs(
  network: string,
  host: string,
  port: number
): string[] {
  // BusyBox `nc HOST PORT` (empty stdin, 2s connect timeout) exits 0 on connect.
  return [
    'run',
    '--rm',
    '--network',
    network,
    'busybox',
    'sh',
    '-c',
    `nc -w 2 ${host} ${port} < /dev/null`,
  ];
}

export function execArgs(container: string, command: string[]): string[] {
  return ['exec', container, ...command];
}

export function runningInspectArgs(name: string): string[] {
  return ['inspect', '-f', '{{.State.Running}}', name];
}

export function composeUpArgs(composeFile: string): string[] {
  return ['compose', '-f', composeFile, 'up', '-d'];
}

export function composeWaitArgs(composeFile: string): string[] {
  return ['compose', '-f', composeFile, 'wait', 'bootstrap'];
}

/**
 * A container runtime (docker, podman, ...).
 *
 * Docker and Podman share the same CLI surface, so a single concrete class
 * covers both — the only thing that varies is the `command` executable, passed
 * in at construction.
 */
export class ContainerRuntime implements ContainerRunner {
  /** The executable invoked for this runtime, e.g. "docker". */
  constructor(readonly command: string) {}

  /** Returns true if this runtime is installed and responds to `--version`. */
  isAvailable(): boolean {
    const result = spawnSync(this.command, versionArgs(), {
      stdio: 'ignore',
      shell: false,
    });
    return result.status === 0;
  }

  /** Returns true if an image with the given tag already exists locally. */
  imageExists(imageTag: string): boolean {
    const result = spawnSync(this.command, imageInspectArgs(imageTag), {
      stdio: 'ignore',
      shell: false,
    });
    return result.status === 0;
  }

  /**
   * Builds an image from a build context, tagging it `imageTag`.
   * The Dockerfile defaults to `<contextDir>/Dockerfile`.
   * Throws on failure — the edge (the spawn action) owns the exit.
   */
  build(imageTag: string, contextDir: string, dockerfile?: string): void {
    const args = buildImageArgs(imageTag, contextDir, dockerfile);

    log.command(`> ${this.command} ${args.join(' ')}`);
    const result = spawnSync(this.command, args, {
      stdio: 'inherit',
      shell: false,
    });

    if (result.error) {
      throw new Error(
        `Failed to start ${this.command}: ${result.error.message}`
      );
    }
    if (result.status !== 0) {
      throw new Error(`Image build failed (exit code ${result.status ?? 1}).`);
    }
  }

  /** Builds the argument list passed to the runtime. */
  buildRunArgs(
    image: string,
    opts: RunOptions,
    commandArgs: string[]
  ): string[] {
    const args = ['run'];

    // Detached is the default; only run in the foreground when --attach is set.
    if (!opts.attach) args.push('-d');
    if (opts.rm) args.push('--rm');
    if (opts.name) args.push('--name', opts.name);
    if (opts.workdir) args.push('-w', opts.workdir);
    if (opts.network) args.push('--network', opts.network);
    for (const host of opts.extraHosts ?? []) args.push('--add-host', host);
    for (const f of opts.envFile ?? []) args.push('--env-file', f);

    for (const v of opts.volumes ?? []) args.push('-v', formatMount(v));
    for (const p of opts.port ?? []) args.push('-p', p);
    for (const e of opts.env ?? []) args.push('-e', e);

    args.push(image);
    args.push(...commandArgs);

    return args;
  }

  /**
   * Runs a container, streaming stdio, and resolves with the container's exit
   * code. It deliberately does not exit the process — the caller (the Run
   * orchestrator) still has to commit, tear down the worktree, and report —
   * so lifecycle control stays with the caller. Rejects only if the runtime
   * process itself fails to start.
   */
  run(image: string, opts: RunOptions, commandArgs: string[]): Promise<number> {
    const runArgs = this.buildRunArgs(image, opts, commandArgs);
    log.info(`Using runtime: ${this.command}`);
    log.command(`> ${this.command} ${runArgs.join(' ')}`);

    return new Promise<number>((resolve, reject) => {
      const child = spawn(this.command, runArgs, {
        stdio: 'inherit',
        shell: false,
      });

      child.on('error', err => {
        reject(new Error(`Failed to start ${this.command}: ${err.message}`));
      });

      child.on('exit', (code, signal) => {
        resolve(signal ? 1 : (code ?? 0));
      });
    });
  }

  /** Starts a Compose stack in the background, preserving its own lifecycle. */
  composeUp(composeFile: string): void {
    const args = composeUpArgs(composeFile);
    log.command(`> ${this.command} ${args.join(' ')}`);
    const result = spawnSync(this.command, args, {
      stdio: 'inherit',
      shell: false,
    });
    if (result.error) {
      throw new Error(
        `Failed to start ${this.command} compose: ${result.error.message}`
      );
    }
    if (result.status !== 0) {
      throw new Error(
        `Compose startup failed (exit code ${result.status ?? 1}).`
      );
    }

    const waitArgs = composeWaitArgs(composeFile);
    log.command(`> ${this.command} ${waitArgs.join(' ')}`);
    const waitResult = spawnSync(this.command, waitArgs, {
      stdio: 'inherit',
      shell: false,
    });
    if (waitResult.error) {
      throw new Error(
        `Failed to wait for ${this.command} compose: ${waitResult.error.message}`
      );
    }
    if (waitResult.status !== 0) {
      throw new Error(
        `Compose bootstrap failed (exit code ${waitResult.status ?? 1}).`
      );
    }

  }

  /** Create a private container network. Throws on failure (a pre-run, fail-fast step). */
  createNetwork(name: string): void {
    const result = spawnSync(this.command, networkCreateArgs(name), {
      stdio: 'ignore',
      shell: false,
    });
    if (result.error) {
      throw new Error(
        `Failed to start ${this.command}: ${result.error.message}`
      );
    }
    if (result.status !== 0) {
      throw new Error(
        `Failed to create network "${name}" (exit code ${result.status ?? 1}).`
      );
    }
  }

  /** Remove a network. Best-effort: swallows every failure so teardown never masks the run result. */
  removeNetwork(name: string): void {
    spawnSync(this.command, networkRemoveArgs(name), {
      stdio: 'ignore',
      shell: false,
    });
  }

  /**
   * Start a sidecar detached on its private network, reachable by its alias. The
   * image's own CMD runs the MCP server; only credentials are passed (by
   * env-file). Throws if the container fails to start.
   */
  startSidecar(spec: SidecarSpec): void {
    const args = sidecarRunArgs(spec);

    log.command(`> ${this.command} ${args.join(' ')}`);
    const result = spawnSync(this.command, args, {
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: false,
    });
    if (result.error) {
      throw new Error(
        `Failed to start ${this.command}: ${result.error.message}`
      );
    }
    if (result.status !== 0) {
      throw new Error(
        `Failed to start sidecar "${spec.name}" (exit code ${result.status ?? 1}).`
      );
    }
  }

  /** Force-remove a container by name (even if running). Best-effort: never throws (teardown). */
  removeContainer(name: string): void {
    spawnSync(this.command, containerRemoveArgs(name), {
      stdio: 'ignore',
      shell: false,
    });
  }

  /**
   * Probe a TCP port over the private network from a throwaway sibling container,
   * mirroring the DNS-by-alias path the agent will use. BusyBox `nc HOST PORT`
   * (fed an empty stdin, 2s connect timeout) exits 0 on a successful connect. The
   * `busybox` image is a tiny public image the runtime auto-pulls on first use.
   */
  probeTcp(network: string, host: string, port: number): boolean {
    const result = spawnSync(this.command, tcpProbeArgs(network, host, port), {
      stdio: 'ignore',
      shell: false,
    });
    return result.status === 0;
  }

  /** Run a readiness command inside the sidecar (`exec`); true iff it exits 0. */
  probeHealthcheck(container: string, command: string[]): boolean {
    const result = spawnSync(this.command, execArgs(container, command), {
      stdio: 'ignore',
      shell: false,
    });
    return result.status === 0;
  }

  /** True if the named container is still running (`inspect` reports `Running: true`). */
  isRunning(name: string): boolean {
    const result = spawnSync(this.command, runningInspectArgs(name), {
      encoding: 'utf8',
      shell: false,
    });
    return result.status === 0 && result.stdout.trim() === 'true';
  }
}
