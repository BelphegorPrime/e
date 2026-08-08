import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import { ContainerRuntime, type RunOptions, type Mount } from './runtime/index';
import { HostGit } from './git/host';
import { runSpawn, type RunSpawnResult } from './runSpawn';
import { orderEnvFiles, decideImageAction, resolveSpawnTarget } from './spawnPlan';
import {
  resolveHarness,
  HARNESSES,
  mcpDeliveryForm,
  fileAdapterFor,
  skillsSupported,
} from './harness/index';
import { findAgent, isKnownTarget, selectAgentByTier, listAgents } from './agent';
import {
  validateProviderProtocol,
  renderProviderEnvFile,
  parseDotenv,
} from './harness/adapter';
import type { McpEndpoint } from './mcp/index';
import { resolveSkill, parseSkillList, skillMountSpec } from './skill/index';
import {
  planProviderDelivery,
  planAgentImage,
  type ProviderDelivery,
  type DerivedImagePlan,
} from './harness/deriveImage';
import { resolveProviderModel, HttpModelsLister } from './model/resolve';
import {
  readMcpServer,
  listMcpServerNames,
  planMcpSelection,
  type McpServer,
} from './mcp/index';
import type { SidecarPlan } from './runSpawn';
import { writeIfAbsent } from './scaffold';
import { imageTag } from './naming';
import { RunScratch } from './runScratch';
import {
  harnessDir,
  agentDir,
  mcpDir,
  skillDir,
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
  /** `--mcp <name...>`: MCP servers to wire for this run (container sidecars and/or remote URLs). */
  mcp?: string[];
  /** `--skill <name...>`: Skills to add for this run (comma-separated or repeated). */
  skill?: string[];
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

/**
 * Resolves a requested `--mcp <name>` to its persisted definition, throwing a
 * clear error (listing the available servers) when it isn't there. A malformed
 * `mcp.json` surfaces as the parse error from {@link readMcpServer}.
 */
function resolveMcpServer(name: string, root: string | undefined): McpServer {
  const server = readMcpServer(name, root);
  if (server) return server;
  const available = listMcpServerNames(root);
  const list = available.length ? available.join(', ') : '(none)';
  throw new Error(
    `Unknown MCP server "${name}". Available: ${list}. ` +
      `Add one under .e/mcp/<name>/ (an mcp.json, plus a Dockerfile for a container server) or run \`e init\`.`,
  );
}

/**
 * Renders an MCP server's required credentials into a throwaway `--env-file`
 * (mode 0600, outside any worktree), resolved by name from `.e/.env`. A missing
 * key is a hard, fail-fast error naming the fix. Returns undefined when the
 * server needs no credentials. `destination` names where the file is delivered —
 * a container server's creds go to its *sidecar*; a remote server's go to the
 * *agent*, whose MCP client expands `${VAR}` in the URL/headers.
 */
function renderMcpEnvFile(
  server: McpServer,
  storeEnv: Record<string, string>,
  scratch: RunScratch,
  destination: 'sidecar' | 'agent',
): string[] | undefined {
  if (server.requiredEnv.length === 0) return undefined;
  const lines = server.requiredEnv.map((name) => {
    const value = storeEnv[name];
    if (value === undefined || value === '') {
      throw new Error(
        `MCP server "${server.name}" needs "${name}" set in .e/.env. ` +
          `Add "${name}=<value>" there — it is injected into the ${destination} at runtime, never baked into an image.`,
      );
    }
    return `${name}=${value}`;
  });
  return [scratch.file(`${server.name}.env`, lines.join('\n') + '\n')];
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
    .option(
      '--mcp <name...>',
      'MCP server(s) to wire for this run — container (sidecar) or remote (hosted URL); repeatable',
    )
    .option(
      '--skill <name...>',
      'Skill(s) to add for this run, from .e/skills (comma-separated or repeated)',
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
        // (ADR-0006) and of any MCP sidecar credentials — read once, used to
        // fetch the model list, resolve the runtime env-file key by name, and
        // render each sidecar's own credential env-file.
        const baseEnvFile = root !== undefined ? envFilePath(root) : undefined;
        const mcpNames = opts.mcp ?? [];
        const needStoreEnv = Boolean(agent.provider) || mcpNames.length > 0;
        const storeEnv = needStoreEnv ? loadStoreEnv(baseEnvFile) : {};

        // Resolve the requested MCP servers and wire them to the harness before
        // any build or worktree, so an unknown server, a bad mcp.json, a harness
        // that cannot take MCP inline, or a missing credential all fail fast and
        // cheap (next to the provider-protocol check above). The manifest's
        // `transport` decides the mechanism: a container server becomes a sidecar
        // (creds → sidecar); a remote server is wired straight to the agent's MCP
        // client (creds → agent, for `${VAR}` expansion), with no sidecar.
        let sidecars: SidecarPlan[] = [];
        let mcpArgs: string[] = [];
        // For a file-delivered harness (Codex): the harness's file adapter and the
        // selected endpoints, merged onto the baked base config and mounted below.
        const fileAdapter = fileAdapterFor(harness);
        let mcpFileEndpoints: McpEndpoint[] | undefined;
        const remoteAuthEnvFiles: string[] = [];
        // Every throwaway host file/dir this run creates (MCP credential
        // env-files, the Codex config overlay, the derived-image build context,
        // the provider env-file) is owned by one RunScratch and removed by a
        // single dispose() once the run returns.
        const scratch = new RunScratch();
        if (mcpNames.length > 0) {
          try {
            if (mcpDeliveryForm(harness) === 'none') {
              throw new Error(
                `Harness "${harness.name}" has no MCP client, so it cannot use --mcp. ` +
                  `Use a harness that supports MCP (e.g. claudeCode or codex).`,
              );
            }
            const servers = mcpNames.map((name) => resolveMcpServer(name, root));
            const plan = planMcpSelection(servers);
            sidecars = plan.containerServers.map((server) => ({
              alias: server.name,
              image: imageTag('mcp', server.name),
              port: server.port,
              healthcheck: server.healthcheck,
              // A sidecar's credentials go to the sidecar, never the agent.
              envFile: renderMcpEnvFile(server, storeEnv, scratch, 'sidecar'),
            }));
            for (const server of plan.remoteServers) {
              // A remote server's credentials go to the agent, whose MCP client
              // expands `${VAR}` in the URL/headers — no sidecar, no network entry.
              const file = renderMcpEnvFile(server, storeEnv, scratch, 'agent');
              if (file) remoteAuthEnvFiles.push(...file);
            }
            // Delivery form per harness (ADR-0006): Claude takes MCP inline on the
            // command line; a file harness (Codex) takes a config-file overlay
            // (merged + mounted below, once the baked base config is known).
            if (harness.renderMcpArgs) {
              mcpArgs = harness.renderMcpArgs(plan.endpoints);
            } else {
              mcpFileEndpoints = plan.endpoints;
            }
          } catch (err) {
            scratch.dispose();
            console.error((err as Error).message);
            process.exit(1);
          }
        }

        // Resolve Skills before any build or worktree (fail-fast). An agent's
        // declared default skills (agent.skills) are baked into its image; --skill
        // adds skills for this run only. Both go to the harness's skills dir
        // outside /workspace (never the run branch); a harness that declares no
        // skills dir is gated off. `--skill` accepts comma-separated or repeated.
        const perRunSkills = parseSkillList(opts.skill ?? []);
        const bakedSkills = agent.skills ?? [];
        const skillMounts: Mount[] = [];
        if (perRunSkills.length > 0 || bakedSkills.length > 0) {
          try {
            if (!skillsSupported(harness) || !harness.skillsDir) {
              const kinds = [
                bakedSkills.length > 0 ? 'baked' : undefined,
                perRunSkills.length > 0 ? '--skill' : undefined,
              ].filter(Boolean);
              throw new Error(
                `Harness "${harness.name}" does not support Skills, so it cannot receive ` +
                  `${kinds.join(' or ')} skills.`,
              );
            }
            // Validate every skill exists (dir + SKILL.md) before building anything.
            for (const name of new Set([...bakedSkills, ...perRunSkills])) {
              resolveSkill(name, root);
            }
            // Per-run skills are delivered as read-only mounts at the harness's
            // skills dir — outside /workspace, so `git status` never sees them.
            for (const name of perRunSkills) {
              skillMounts.push(skillMountSpec(skillDir(name, root), harness.skillsDir, name));
            }
          } catch (err) {
            scratch.dispose();
            console.error((err as Error).message);
            process.exit(1);
          }
        }

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
            );
          } catch (err) {
            console.error((err as Error).message);
            process.exit(1);
          }
        }

        // Codex (file-delivered MCP): merge the selected servers onto the baked
        // base config and deliver it as a runtime overlay — a single read-only
        // file mounted over the config dir (outside /workspace), with CODEX_HOME
        // pointed at that dir so both a provider agent and a default agent read
        // it. The base is the exact config the derived image baked (reused, never
        // re-derived), or empty for a default agent.
        const configMounts: Mount[] = [];
        const agentEnv: string[] = [...(opts.env ?? [])];
        if (mcpFileEndpoints !== undefined && fileAdapter?.planConfigOverlay) {
          try {
            // The overlay's base is the exact config the derived image baked
            // (same adapter, same file) — empty for a default agent. The adapter
            // returns the merged file, the container path to mount it at, and the
            // config-dir relocation env; the edge only writes and wires them.
            const overlay = fileAdapter.planConfigOverlay(
              delivery?.bakedConfig?.file.content ?? '',
              mcpFileEndpoints,
            );
            const hostFile = scratch.file(overlay.file.fileName, overlay.file.content);
            configMounts.push({ host: hostFile, container: overlay.mountTo, ro: true });
            // Read config from the mounted dir regardless of a baked default.
            agentEnv.push(...overlay.env);
          } catch (err) {
            scratch.dispose();
            console.error((err as Error).message);
            process.exit(1);
          }
        }

        // Compose the derived agent image (ADR-0004 layer 2): the baked provider
        // config (file harness) and/or the agent's default skills. Undefined when
        // there is nothing to bake — then the run uses the harness base directly.
        const agentImagePlan: DerivedImagePlan | undefined = planAgentImage({
          baseImage: harness.imageTag,
          agentName: agent.name,
          bakedConfig: delivery?.bakedConfig,
          skills:
            bakedSkills.length > 0 && harness.skillsDir
              ? { skillsDir: harness.skillsDir, names: bakedSkills }
              : undefined,
        });

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
        // scaffolding. A derived agent image (baked provider config and/or
        // default skills) runs on the harness base; everything else runs the base.
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

          if (!agentImagePlan) return harness.imageTag;

          // Render the derived agent's files under `.e/agents/<name>/` — never
          // clobbering a hand edit, a divergence is shown as a diff (ADR-0004),
          // and the config lives outside `/workspace`.
          const dir = agentDir(agent.name, root);
          for (const file of agentImagePlan.files) {
            writeIfAbsent(dir, path.join(dir, file.fileName), file.content);
          }
          const tag = agentImagePlan.imageTag;
          if (opts.rebuild || !runtime.imageExists(tag)) {
            if (agentImagePlan.skillNames.length === 0) {
              // No baked skills: the agent dir is the whole build context.
              runtime.build(tag, dir);
            } else {
              // Baked skills are file trees, not rendered strings, so assemble a
              // temp build context: the rendered agent files plus each skill tree
              // copied to `skills/<name>/` (where the Dockerfile's COPY expects it).
              const ctx = scratch.dir();
              fs.cpSync(dir, ctx, { recursive: true });
              for (const name of agentImagePlan.skillNames) {
                fs.cpSync(skillDir(name, root), path.join(ctx, 'skills', name), {
                  recursive: true,
                });
              }
              runtime.build(tag, ctx);
            }
          }
          return tag;
        };

        // Builds every requested sidecar's image from `.e/mcp/<name>/`, mirroring
        // ensureImage: runSpawn calls it before the worktree, so a sidecar build
        // failure never leaves orphan scaffolding (ADR-0005). `resolveMcpServer`
        // already confirmed each definition exists.
        const ensureSidecarImages = (): void => {
          for (const server of sidecars) {
            const tag = server.image;
            if (opts.rebuild || !runtime.imageExists(tag)) {
              runtime.build(tag, mcpDir(server.alias, root));
            }
          }
        };

        // Load the shared `.e/.env` as the base environment (if present),
        // then the user's --env-file on top, so it overrides the base.
        const envFiles = orderEnvFiles(
          baseEnvFile !== undefined && fs.existsSync(baseEnvFile)
            ? baseEnvFile
            : undefined,
          opts.envFile,
        );

        // A remote MCP server's credentials are delivered to the agent so its MCP
        // client can expand `${VAR}` in the server's URL/headers at runtime.
        envFiles.push(...remoteAuthEnvFiles);

        // If the agent declares a provider, deliver its runtime env via a
        // throwaway env-file (outside the worktree), layered last so it takes
        // effect. The delivery plan decided what that env is — the whole
        // provider for an env harness, only the API key for a file harness. The
        // key is resolved by name from the already-loaded `.e/.env` (ADR-0006),
        // never inlined on argv; the file is removed once the run returns.
        if (delivery) {
          try {
            const content = renderProviderEnvFile(
              delivery.runtimeEnv,
              (name) => storeEnv[name],
            );
            envFiles.push(scratch.file('provider.env', content));
          } catch (err) {
            scratch.dispose();
            console.error((err as Error).message);
            process.exit(1);
          }
        }

        const runOptions: RunOptions = {
          attach: opts.attach,
          rm: opts.rm,
          port: opts.port,
          env: agentEnv,
          envFile: envFiles,
        };

        let result: RunSpawnResult;
        try {
          result = await runSpawn(
            { git: new HostGit(), runtime, ensureImage, ensureSidecarImages },
            {
              agent,
              harness,
              prompt: resolved.prompt.join(' '),
              model: delivery?.runtimeModel,
              name: opts.name,
              runOptions,
              sidecars,
              mcpArgs,
              // The Codex MCP config overlay and the per-run skill mounts are both
              // read-only mounts outside /workspace, delivered together.
              configMounts: [...configMounts, ...skillMounts],
            },
          );
        } catch (err) {
          scratch.dispose();
          console.error((err as Error).message);
          process.exit(1);
        } finally {
          // The rendered env-files hold resolved secrets; drop them as soon as
          // the run returns (each container already has its copy).
          scratch.dispose();
        }

        if (result.error) {
          console.error(result.error);
          process.exit(result.exitCode);
        }

        for (const warning of result.sidecarWarnings ?? []) {
          console.warn(`Warning: ${warning}`);
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
