import fs from 'fs';
import type { Command } from 'commander';
import { ContainerRuntime, type RunOptions } from './runtime/index';
import { HostGit } from './git/host';
import { runSpawn, type RunSpawnResult } from './runSpawn';
import { orderEnvFiles, decideImageAction } from './spawnPlan';
import { resolveHarness, HARNESSES } from './harness/index';
import { findAgent } from './agent';
import { harnessDir, isInitialized, findRoot, envFilePath } from './store';

/** Available runtimes, mapping name → executable, in auto-detection order. */
const RUNTIMES: Record<string, string> = {
  docker: 'docker',
  podman: 'podman',
};

/**
 * Resolves which container runtime to use.
 * If `preferred` is given, it must be a known runtime and be available.
 * Otherwise the first available runtime is returned (docker preferred over podman).
 */
export function resolveRuntime(preferred?: string): ContainerRuntime {
  if (preferred) {
    const command = RUNTIMES[preferred];
    if (!command) {
      throw new Error(
        `Invalid runtime "${preferred}". Valid values: ${Object.keys(RUNTIMES).join(', ')}.`,
      );
    }
    const runtime = new ContainerRuntime(command);
    if (!runtime.isAvailable()) {
      throw new Error(
        `Requested runtime "${preferred}" is not installed or not on PATH.`,
      );
    }
    return runtime;
  }

  for (const command of Object.values(RUNTIMES)) {
    const runtime = new ContainerRuntime(command);
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
      '[target]',
      `agent or harness to run (harnesses: ${Object.keys(HARNESSES).join(', ')})`,
    )
    .argument('[prompt...]', 'instruction passed to the harness')
    .option(
      '--runtime <runtime>',
      'container runtime to use (docker or podman)',
    )
    .option('--name <name>', 'name for the run (overrides the prompt-derived slug)')
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
      'run detached (unsupported with per-run worktrees; run in the foreground)',
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
      async (
        target: string | undefined,
        prompt: string[],
        opts: SpawnCommandOptions,
      ) => {
        if (target === undefined) {
          console.error('error: missing required argument \'target\'\n');
          console.error('Available harnesses:');
          for (const name of Object.keys(HARNESSES)) {
            console.error(`  ${name}`);
          }
          process.exit(1);
        }

        const root = findRoot(opts.dir);

        // Resolve the spawn target to an Agent (a persisted agent by that name,
        // or a bare harness name → its default agent), then the Harness the
        // agent runs — the image and invocation stay keyed on the harness.
        const agent = (() => {
          try {
            return findAgent(target, root);
          } catch (err) {
            console.error((err as Error).message);
            process.exit(1);
          }
        })();

        // findAgent has already validated that the agent's harness is a known
        // harness, so this resolution cannot fail.
        const harness = resolveHarness(agent.harness);

        let runtime: ContainerRuntime;
        try {
          runtime = resolveRuntime(opts.runtime);
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }

        // Builds the harness image on demand. The orchestrator calls this
        // after confirming a git repo but before creating the worktree, so a
        // thrown failure never leaves orphan scaffolding.
        const ensureImage = (): void => {
          // Preserve the short-circuit: with --rebuild the decision is always
          // `build`, so skip the (otherwise wasted) image-inspect probe.
          const imageExists =
            !opts.rebuild && runtime.imageExists(harness.imageTag);
          const initialized =
            root !== undefined && isInitialized(harness.name, root);
          const action = decideImageAction({
            rebuild: Boolean(opts.rebuild),
            imageExists,
            initialized,
          });
          if (action === 'not-initialized') {
            throw new Error(
              `Harness "${harness.name}" is not initialized. Run \`e init\`${opts.dir ? ` --dir ${opts.dir}` : ''} first.`,
            );
          }
          if (action === 'build') {
            runtime.build(harness.imageTag, harnessDir(harness.name, root));
          }
        };

        // Load the shared `.e/.env` as the base environment (if present),
        // then the user's --env-file on top, so it overrides the base.
        const baseEnvFile =
          root !== undefined ? envFilePath(root) : undefined;
        const envFiles = orderEnvFiles(
          baseEnvFile !== undefined && fs.existsSync(baseEnvFile)
            ? baseEnvFile
            : undefined,
          opts.envFile,
        );

        const runOptions: RunOptions = {
          attach: opts.attach,
          rm: opts.rm,
          port: opts.port,
          env: opts.env,
          envFile: envFiles,
        };

        let result: RunSpawnResult;
        try {
          result = await runSpawn(
            { git: new HostGit(), runtime, ensureImage },
            {
              agent,
              harness,
              prompt: prompt.join(' '),
              name: opts.name,
              runOptions,
            },
          );
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }

        if (result.error) {
          console.error(result.error);
          process.exit(result.exitCode);
        }

        if (result.pushWarning) {
          console.warn(`Warning: ${result.pushWarning}`);
        }
        console.log(`\nRun branch: ${result.branch}`);
        if (result.pushed) {
          console.log('Pushed to origin. Open a PR or merge when you like.');
        }
        process.exit(result.exitCode);
      },
    );
}
