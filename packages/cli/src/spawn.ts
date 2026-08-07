import type { Command } from 'commander';
import { ContainerRuntime, type RunOptions } from './runtime/index';
import { DockerRuntime } from './runtime/docker';
import { PodmanRuntime } from './runtime/podman';

/** Available runtimes, in the order they are tried during auto-detection. */
const RUNTIMES: Record<string, () => ContainerRuntime> = {
  docker: () => new DockerRuntime(),
  podman: () => new PodmanRuntime(),
};

/**
 * Resolves which container runtime to use.
 * If `preferred` is given, it must be a known runtime and be available.
 * Otherwise the first available runtime is returned (docker preferred over podman).
 */
export function resolveRuntime(preferred?: string): ContainerRuntime {
  if (preferred) {
    const factory = RUNTIMES[preferred];
    if (!factory) {
      throw new Error(
        `Invalid runtime "${preferred}". Valid values: ${Object.keys(RUNTIMES).join(', ')}.`,
      );
    }
    const runtime = factory();
    if (!runtime.isAvailable()) {
      throw new Error(
        `Requested runtime "${preferred}" is not installed or not on PATH.`,
      );
    }
    return runtime;
  }

  for (const factory of Object.values(RUNTIMES)) {
    const runtime = factory();
    if (runtime.isAvailable()) {
      return runtime;
    }
  }

  throw new Error(
    `No container runtime found. Install docker or podman, or make sure it is on PATH.`,
  );
}

interface SpawnCommandOptions extends RunOptions {
  runtime?: string;
}

export function registerSpawnCommand(program: Command): void {
  program
    .command('spawn')
    .description('Start a docker (or podman) container')
    .argument('<image>', 'container image to run, e.g. nginx:latest')
    .argument('[args...]', 'command and arguments to run inside the container')
    .option(
      '--runtime <runtime>',
      'container runtime to use (docker or podman)',
    )
    .option('--name <name>', 'assign a name to the container')
    .option(
      '-a, --attach',
      'run the container in the foreground (default: detached)',
      false,
    )
    .option('--rm', 'automatically remove the container when it exits', false)
    .option(
      '-p, --port <port...>',
      'publish a container port, e.g. 8080:80 (repeatable)',
    )
    .option(
      '-e, --env <env...>',
      'set an environment variable, e.g. KEY=value (repeatable)',
    )
    .action(
      (image: string, commandArgs: string[], opts: SpawnCommandOptions) => {
        let runtime: ContainerRuntime;
        try {
          runtime = resolveRuntime(opts.runtime);
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }

        runtime.run(image, opts, commandArgs);
      },
    );
}
