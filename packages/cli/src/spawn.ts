import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Command } from 'commander';
import { ContainerRuntime, type RunOptions } from './runtime/index';
import { HostGit } from './git/host';
import { runSpawn, type RunSpawnResult } from './runSpawn';
import { orderEnvFiles, decideImageAction, resolveSpawnTarget } from './spawnPlan';
import { resolveHarness, HARNESSES } from './harness/index';
import { findAgent, isKnownTarget, selectAgentByTier, listAgents } from './agent';
import {
  validateProviderProtocol,
  renderProviderEnvFile,
  parseDotenv,
} from './harness/adapter';
import {
  planProviderDelivery,
  type ProviderDelivery,
} from './harness/deriveImage';
import { resolveProviderModel, HttpModelsLister } from './model/resolve';
import { writeIfAbsent } from './scaffold';
import {
  harnessDir,
  agentDir,
  isInitialized,
  findRoot,
  envFilePath,
  readConfig,
} from './store';

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
  /** `--tier <tier>`: select the (harness, tier) agent rather than by name. */
  tier?: string;
}

/**
 * Reads the store's shared `.e/.env` into a key→value map, for resolving a
 * provider's `apiKeyEnv` by name. This is the sole source of a provider's API
 * key (ADR-0006); a missing or unreadable file yields an empty map, so an unset
 * key surfaces as the adapter's clear "add it to .e/.env" error.
 */
function loadStoreEnv(baseEnvFile: string | undefined): Record<string, string> {
  if (baseEnvFile === undefined || !fs.existsSync(baseEnvFile)) return {};
  return parseDotenv(fs.readFileSync(baseEnvFile, 'utf8'));
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
    .option(
      '--tier <tier>',
      'select the agent for a harness by tier (e.g. smart, fast, cheap, review)',
    )
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
        const root = findRoot(opts.dir);
        const defaultHarness = readConfig(root).defaultHarness;

        // Decide what the positional args mean and resolve the Agent to run.
        // With `--tier`, the target (or the favorite) names a *harness* and the
        // tier selects its agent; without it, the target is an agent/harness
        // name resolved directly (a bare harness → its default agent).
        const resolved = resolveSpawnTarget({
          target,
          prompt,
          defaultHarness,
          isKnownTarget: opts.tier
            ? (name) => Object.keys(HARNESSES).includes(name)
            : (name) => isKnownTarget(name, root),
        });

        const agent = (() => {
          try {
            return opts.tier
              ? selectAgentByTier(resolved.agentTarget, opts.tier, listAgents(root))
              : findAgent(resolved.agentTarget, root);
          } catch (err) {
            console.error((err as Error).message);
            process.exit(1);
          }
        })();

        // findAgent / selectAgentByTier have validated the agent's harness, so
        // this resolution cannot fail.
        const harness = resolveHarness(agent.harness);

        // Reject a provider protocol the harness does not speak before building
        // any image or cutting a worktree, so a mismatch fails fast and cheap.
        try {
          validateProviderProtocol(agent.provider, harness);
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }

        // The shared `.e/.env` is the sole source of a provider's API key
        // (ADR-0006) — read once, used both to fetch the model list and to
        // resolve the runtime env-file key by name.
        const baseEnvFile = root !== undefined ? envFilePath(root) : undefined;
        const storeEnv = agent.provider ? loadStoreEnv(baseEnvFile) : {};

        // Plan how the provider (if any) reaches the run: resolve its model
        // (a concrete id as-is; `auto` against the endpoint's `/v1/models` for
        // the agent's tier — ADR-0007), then decide the delivery form (runtime
        // env for an env harness, a derived-image build for a file harness).
        // Runs before runtime detection or any build so a bad provider, an
        // unreachable endpoint, or a missing adapter fails fast and cheap.
        let delivery: ProviderDelivery | undefined;
        if (agent.provider) {
          try {
            if (!harness.adapter) {
              throw new Error(
                `Harness "${harness.name}" has no config adapter, so it cannot deliver a provider yet.`,
              );
            }
            const resolvedModel = await resolveProviderModel(
              agent.provider,
              agent.tier,
              new HttpModelsLister((name) => storeEnv[name]),
            );
            delivery = planProviderDelivery(
              harness.adapter,
              agent.provider,
              resolvedModel,
              { agentName: agent.name, baseImage: harness.imageTag },
            );
          } catch (err) {
            console.error((err as Error).message);
            process.exit(1);
          }
        }

        let runtime: ContainerRuntime;
        try {
          runtime = resolveRuntime(opts.runtime);
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }

        // Builds the image this run executes and returns its tag. The
        // orchestrator calls this after confirming a git repo but before
        // creating the worktree, so a thrown failure never leaves orphan
        // scaffolding. A file-configured provider (Codex) runs a derived agent
        // image baked on the harness base; everything else runs the base image.
        const ensureImage = (): string => {
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

          if (!delivery?.derived) return harness.imageTag;

          // Render the derived agent's files under `.e/agents/<name>/` — never
          // clobbering a hand edit, a divergence is shown as a diff (ADR-0004),
          // and the config lives outside `/workspace`. Then build the thin
          // layer-2 image on the (now-present) base; the key is not baked, it is
          // delivered at runtime by name (see the provider env-file below).
          const dir = agentDir(agent.name, root);
          for (const file of delivery.derived.files) {
            writeIfAbsent(dir, path.join(dir, file.fileName), file.content);
          }
          const tag = delivery.derived.imageTag;
          if (opts.rebuild || !runtime.imageExists(tag)) {
            runtime.build(tag, dir);
          }
          return tag;
        };

        // Load the shared `.e/.env` as the base environment (if present),
        // then the user's --env-file on top, so it overrides the base.
        const envFiles = orderEnvFiles(
          baseEnvFile !== undefined && fs.existsSync(baseEnvFile)
            ? baseEnvFile
            : undefined,
          opts.envFile,
        );

        // If the agent declares a provider, deliver its runtime env via a
        // throwaway env-file (outside the worktree), layered last so it takes
        // effect. The delivery plan decided what that env is — the whole
        // provider for an env harness, only the API key for a file harness. The
        // key is resolved by name from the already-loaded `.e/.env` (ADR-0006),
        // never inlined on argv; the file is removed once the run returns.
        let providerEnvDir: string | undefined;
        const cleanupProviderEnv = (): void => {
          if (providerEnvDir) {
            fs.rmSync(providerEnvDir, { recursive: true, force: true });
            providerEnvDir = undefined;
          }
        };
        if (delivery) {
          try {
            const content = renderProviderEnvFile(
              delivery.runtimeEnv,
              (name) => storeEnv[name],
            );
            providerEnvDir = fs.mkdtempSync(
              path.join(os.tmpdir(), 'e-provider-'),
            );
            const providerEnvFile = path.join(providerEnvDir, 'provider.env');
            fs.writeFileSync(providerEnvFile, content, { mode: 0o600 });
            envFiles.push(providerEnvFile);
          } catch (err) {
            cleanupProviderEnv();
            console.error((err as Error).message);
            process.exit(1);
          }
        }

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
              prompt: resolved.prompt.join(' '),
              model: delivery?.runtimeModel,
              name: opts.name,
              runOptions,
            },
          );
        } catch (err) {
          cleanupProviderEnv();
          console.error((err as Error).message);
          process.exit(1);
        } finally {
          // The rendered provider env-file holds a resolved secret; drop it as
          // soon as the run returns (the container already has its copy).
          cleanupProviderEnv();
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
