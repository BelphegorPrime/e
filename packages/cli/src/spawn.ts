import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import { ContainerRuntime, type RunOptions } from './runtime/index';
import { DockerRuntime } from './runtime/docker';
import { PodmanRuntime } from './runtime/podman';
import {
  resolveHarness,
  harnessDir,
  isInitialized,
  findHarnessRoot,
  envFilePath,
  HARNESSES,
} from './harness/index';

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

interface SpawnCommandOptions extends Omit<RunOptions, 'envFile'> {
  runtime?: string;
  mount?: string;
  rebuild?: boolean;
  dir?: string;
  /** Raw `--env-file <path>` value from the CLI (a single path). */
  envFile?: string;
}

export function registerSpawnCommand(program: Command): void {
  program
    .command('spawn')
    .description('Build and run a coding harness in a container')
    .argument(
      '<harness>',
      `coding harness to run (${Object.keys(HARNESSES).join(', ')})`,
    )
    .argument('[prompt...]', 'instruction passed to the harness')
    .option(
      '--runtime <runtime>',
      'container runtime to use (docker or podman)',
    )
    .option('--name <name>', 'assign a name to the container')
    .option(
      '--mount <dir>',
      'host directory to mount at /workspace (default: current directory)',
    )
    .option('--env-file <path>', 'load environment variables from a file')
    .option('--rebuild', 'force a rebuild of the harness image', false)
    .option(
      '--dir <path>',
      'root directory holding the harness Dockerfiles (default: home directory)',
    )
    .option(
      '-a, --attach',
      'run the container in the foreground',
      true,
    )
    .option(
      '--no-attach',
      'run the container detached instead of in the foreground',
    )
    .option(
      '--rm',
      'automatically remove the container when it exits',
      true,
    )
    .option('--no-rm', 'keep the container after it exits')
    .option(
      '-p, --port <port...>',
      'publish a container port, e.g. 8080:80 (repeatable)',
    )
    .option(
      '-e, --env <env...>',
      'set an environment variable, e.g. KEY=value (repeatable)',
    )
    .action(
      (harnessName: string, prompt: string[], opts: SpawnCommandOptions) => {
        const harness = (() => {
          try {
            return resolveHarness(harnessName);
          } catch (err) {
            console.error((err as Error).message);
            process.exit(1);
          }
        })();

        let runtime: ContainerRuntime;
        try {
          runtime = resolveRuntime(opts.runtime);
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }

        const root = findHarnessRoot(opts.dir);

        if (opts.rebuild || !runtime.imageExists(harness.imageTag)) {
          if (root === undefined || !isInitialized(harness, root)) {
            console.error(
              `Harness "${harness.name}" is not initialized. Run \`e init\`${opts.dir ? ` --dir ${opts.dir}` : ''} first.`,
            );
            process.exit(1);
          }
          runtime.build(harness.imageTag, harnessDir(harness, root));
        }

        const mountDir = path.resolve(opts.mount ?? process.cwd());

        // Load the shared `.e/.env` as the base environment (if present),
        // then the user's --env-file on top, so it overrides the base.
        const envFiles: string[] = [];
        if (root !== undefined) {
          const baseEnvFile = envFilePath(root);
          if (fs.existsSync(baseEnvFile)) envFiles.push(baseEnvFile);
        }
        if (opts.envFile) envFiles.push(opts.envFile);

        const runOptions: RunOptions = {
          name: opts.name,
          attach: opts.attach,
          rm: opts.rm,
          port: opts.port,
          env: opts.env,
          envFile: envFiles,
          volume: [`${mountDir}:/workspace`],
          workdir: '/workspace',
        };

        runtime.run(
          harness.imageTag,
          runOptions,
          harness.buildCommand(prompt.join(' ')),
        );
      },
    );
}
