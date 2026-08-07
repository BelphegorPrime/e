import { spawn, spawnSync } from 'child_process';

export interface RunOptions {
  name?: string;
  attach?: boolean;
  port?: string[];
  env?: string[];
  rm?: boolean;
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
