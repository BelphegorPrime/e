import { spawn, spawnSync } from 'child_process';

export interface RunOptions {
  name?: string;
  attach?: boolean;
  port?: string[];
  env?: string[];
  rm?: boolean;
  /** Bind mounts, each "hostPath:containerPath". */
  volume?: string[];
  /** Working directory inside the container (-w). */
  workdir?: string;
  /**
   * Env files loaded into the container (--env-file), in order. Later files
   * override earlier ones for the same key; `-e` vars override all of them.
   */
  envFile?: string[];
}

/**
 * The run surface the orchestrator depends on. Kept minimal so a fake can
 * stand in for a real runtime in tests.
 */
export interface ContainerRunner {
  run(image: string, opts: RunOptions, commandArgs: string[]): Promise<number>;
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
    const result = spawnSync(this.command, ['--version'], {
      stdio: 'ignore',
      shell: false,
    });
    return result.status === 0;
  }

  /** Returns true if an image with the given tag already exists locally. */
  imageExists(imageTag: string): boolean {
    const result = spawnSync(this.command, ['image', 'inspect', imageTag], {
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
    const args = ['build', '-t', imageTag];
    if (dockerfile) args.push('-f', dockerfile);
    args.push(contextDir);

    console.log(`> ${this.command} ${args.join(' ')}`);
    const result = spawnSync(this.command, args, {
      stdio: 'inherit',
      shell: false,
    });

    if (result.error) {
      throw new Error(
        `Failed to start ${this.command}: ${result.error.message}`,
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
    commandArgs: string[],
  ): string[] {
    const args = ['run'];

    // Detached is the default; only run in the foreground when --attach is set.
    if (!opts.attach) args.push('-d');
    if (opts.rm) args.push('--rm');
    if (opts.name) args.push('--name', opts.name);
    if (opts.workdir) args.push('-w', opts.workdir);
    for (const f of opts.envFile ?? []) args.push('--env-file', f);

    for (const v of opts.volume ?? []) args.push('-v', v);
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
    console.log(`Using runtime: ${this.command}`);
    console.log(`> ${this.command} ${runArgs.join(' ')}`);

    return new Promise<number>((resolve, reject) => {
      const child = spawn(this.command, runArgs, {
        stdio: 'inherit',
        shell: false,
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to start ${this.command}: ${err.message}`));
      });

      child.on('exit', (code, signal) => {
        resolve(signal ? 1 : (code ?? 0));
      });
    });
  }
}
