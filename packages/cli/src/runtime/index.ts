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
  /** Path to an env file loaded into the container (--env-file). */
  envFile?: string;
}

/**
 * Base class for a container runtime (docker, podman, ...).
 *
 * Docker and Podman share the same `run` CLI surface, so all of the shared
 * behaviour lives here; concrete runtimes only need to provide their `command`.
 */
export abstract class ContainerRuntime {
  /** The executable invoked for this runtime, e.g. "docker". */
  abstract readonly command: string;

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
   * Exits the process on failure.
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
      console.error(
        `Failed to start ${this.command}: ${result.error.message}`,
      );
      process.exit(1);
    }
    if (result.status !== 0) {
      console.error(`Image build failed (exit code ${result.status ?? 1}).`);
      process.exit(result.status ?? 1);
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
    if (opts.envFile) args.push('--env-file', opts.envFile);

    for (const v of opts.volume ?? []) args.push('-v', v);
    for (const p of opts.port ?? []) args.push('-p', p);
    for (const e of opts.env ?? []) args.push('-e', e);

    args.push(image);
    args.push(...commandArgs);

    return args;
  }

  /** Runs a container, streaming stdio, and exits with the container's code. */
  run(image: string, opts: RunOptions, commandArgs: string[]): void {
    const runArgs = this.buildRunArgs(image, opts, commandArgs);
    console.log(`Using runtime: ${this.command}`);
    console.log(`> ${this.command} ${runArgs.join(' ')}`);

    const child = spawn(this.command, runArgs, {
      stdio: 'inherit',
      shell: false,
    });

    child.on('error', (err) => {
      console.error(`Failed to start ${this.command}: ${err.message}`);
      process.exit(1);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        process.exit(1);
      }
      process.exit(code ?? 0);
    });
  }
}
