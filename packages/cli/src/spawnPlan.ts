/**
 * Pure decisions behind the `spawn` command. The command action stays a thin
 * edge that performs the I/O (filesystem, runtime) and effects (`process.exit`,
 * `console`); the branching logic that decides *what* to do lives here so it can
 * be tested directly, without building an image or running a container.
 *
 * The edge gathers {@link SpawnFacts} (all I/O), then: {@link validateSpawn}
 * (pure, fail-fast) → resolve the model (the one remaining I/O) → {@link
 * planSpawn} (pure) → execute the returned {@link SpawnPlan}. Everything that
 * decides *what* the run is — including rendering every credential env-file and
 * throwing on a missing secret — happens purely here; the edge only performs the
 * effects the plan names (ADR-0008).
 */

import type { Agent } from './agent';
import type { Harness } from './harness/index';
import { harnessCapabilities, planMcpDelivery } from './harness/index';
import { validateProviderProtocol, EnvFileRenderer } from './harness/adapter';
import type { ConfigOverlayDelivery, ContainerEnv } from './harness/adapter';
import {
  planProviderDelivery,
  planAgentImage,
  type ProviderDelivery,
  type DerivedImagePlan,
} from './harness/deriveImage';
import { planMcpSelection, type McpServer } from './mcp/index';
import type { ResolvedModel } from './model/resolve';
import type { Mount } from './runtime/index';
import type { SidecarPlan } from './runSpawn';
import { imageTag } from './naming';
import { skillMountSpec } from './skill/index';
import { skillDir } from './store';

/**
 * The env files a run loads, in precedence order. `--env-file` entries loaded
 * later override earlier ones for the same key, so the shared base `.e/.env`
 * comes first and the user's `--env-file` second. Absent inputs are dropped;
 * the caller decides presence (the base file must exist on disk, the user file
 * is whatever `--env-file` was given).
 */
export function orderEnvFiles(
  baseEnvPath: string | undefined,
  userEnvFile: string | undefined,
): string[] {
  const files: string[] = [];
  if (baseEnvPath !== undefined) files.push(baseEnvPath);
  if (userEnvFile !== undefined) files.push(userEnvFile);
  return files;
}

/** Inputs to the image-build gate; all pre-resolved by the caller. */
export interface ImageActionInput {
  /** `--rebuild` was passed: always (re)build. */
  rebuild: boolean;
  /** An image with the harness's tag already exists locally. */
  imageExists: boolean;
  /** `e init` has written this harness's Dockerfile under the resolved root. */
  initialized: boolean;
}

/**
 * Decides what a spawn should do about the harness image before running:
 *
 * - `skip` — a usable image is already present and no rebuild was requested.
 * - `build` — an image is needed and the harness is initialized (has a Dockerfile).
 * - `not-initialized` — an image is needed but the harness has no Dockerfile;
 *   the caller surfaces the "run `e init`" error.
 *
 * The caller performs the effect the decision names; this function does no I/O.
 */
export function decideImageAction({
  rebuild,
  imageExists,
  initialized,
}: ImageActionInput): 'skip' | 'build' | 'not-initialized' {
  const needBuild = rebuild || !imageExists;
  if (!needBuild) return 'skip';
  return initialized ? 'build' : 'not-initialized';
}

/** Inputs to the pure spawn-target resolution; the glue supplies the real values. */
export interface SpawnTargetInput {
  /** First positional arg, or `undefined` when `e spawn` was given none. */
  target: string | undefined;
  /** Remaining positional args (the prompt words after `target`). */
  prompt: string[];
  /** The favorite harness from `config.json`, used when no target is named. */
  defaultHarness: string;
  /** Predicate: does `name` name a persisted agent or a known harness? */
  isKnownTarget: (name: string) => boolean;
}

/** What a spawn's positional args resolve to. */
export interface SpawnTarget {
  /** The name to resolve to an Agent — a known agent/harness, or the favorite. */
  agentTarget: string;
  /** The prompt words, joined by the caller. */
  prompt: string[];
}

/**
 * Decides, purely, what a spawn's positional args mean:
 *
 * - No `target` at all → run the favorite harness's default agent, empty prompt.
 * - `target` names a known agent/harness → that is the target; the rest is the
 *   prompt (unchanged `e spawn <agent|harness> <prompt>` behavior).
 * - `target` names nothing known → every positional is the prompt, run on the
 *   favorite harness's default agent (`e spawn "<prompt>"`).
 *
 * The returned `agentTarget` is fed through the existing agent resolution, which
 * validates it and surfaces a clear error if even the favorite is unknown.
 */
export function resolveSpawnTarget({
  target,
  prompt,
  defaultHarness,
  isKnownTarget,
}: SpawnTargetInput): SpawnTarget {
  if (target === undefined) {
    return { agentTarget: defaultHarness, prompt: [] };
  }
  if (isKnownTarget(target)) {
    return { agentTarget: target, prompt };
  }
  return { agentTarget: defaultHarness, prompt: [target, ...prompt] };
}

/**
 * Everything a spawn's decisions need, gathered by the edge from disk (and the
 * CLI args) so that {@link validateSpawn} and {@link planSpawn} can be pure. The
 * resolved model is *not* here — it needs a network call, so the edge resolves it
 * between validate and plan and passes it to {@link planSpawn} separately.
 */
export interface SpawnFacts {
  /** The store root, or undefined when no `.e` store was found. */
  root: string | undefined;
  /** The resolved Agent to run. */
  agent: Agent;
  /** The Harness the agent runs. */
  harness: Harness;
  /** Parsed `.e/.env` (secrets resolved by name from here; never baked). */
  storeEnv: Record<string, string>;
  /** The requested `--mcp` servers, already resolved from disk (existence checked). */
  mcpServers: McpServer[];
  /** Per-run `--skill` names (existence checked on disk during gather). */
  perRunSkills: string[];
  /** The agent's baked default skills (`agent.skills`). */
  bakedSkills: string[];
  /** The prompt, joined into a single string. */
  prompt: string;
  /** `--rebuild`. */
  rebuild: boolean;
  /** `--name` run-name override. */
  name?: string;
  /** `-e` env entries. */
  env: string[];
  /** `-p` port publishes. */
  port?: string[];
  /** `--attach` (foreground). */
  attach?: boolean;
  /** `--rm`. */
  rm?: boolean;
  /** The shared `.e/.env` path when it exists on disk, for env-file layering. */
  baseEnvFile?: string;
  /** The user's `--env-file` path, layered over the base. */
  userEnvFile?: string;
  /** The raw `--dir` value, only for the "run `e init` --dir <x>" hint. */
  dirOpt?: string;
}

/**
 * The pure, fail-fast validation that must pass before the (expensive) model
 * resolution and any build. Throws with a clear message on the first problem:
 *  - a provider protocol the harness does not speak;
 *  - a provider on a harness with no config adapter;
 *  - `--mcp` against a harness with no MCP client;
 *  - baked or `--skill` skills against a harness that supports none.
 * Server/skill *existence* is checked by the edge during gather (it needs disk).
 */
export function validateSpawn(facts: SpawnFacts): void {
  const { agent, harness } = facts;
  const caps = harnessCapabilities(harness);

  validateProviderProtocol(agent.provider, harness);

  if (agent.provider && caps.provider === 'none') {
    throw new Error(
      `Harness "${harness.name}" has no config adapter, so it cannot deliver a provider yet.`,
    );
  }

  if (facts.mcpServers.length > 0 && caps.mcp === 'none') {
    throw new Error(
      `Harness "${harness.name}" has no MCP client, so it cannot use --mcp. ` +
        `Use a harness that supports MCP (e.g. claudeCode or codex).`,
    );
  }

  if (
    (facts.bakedSkills.length > 0 || facts.perRunSkills.length > 0) &&
    caps.skills === undefined
  ) {
    const kinds = [
      facts.bakedSkills.length > 0 ? 'baked' : undefined,
      facts.perRunSkills.length > 0 ? '--skill' : undefined,
    ].filter(Boolean);
    throw new Error(
      `Harness "${harness.name}" does not support Skills, so it cannot receive ` +
        `${kinds.join(' or ')} skills.`,
    );
  }
}

/**
 * Maps an MCP server's required credentials to {@link ContainerEnv} refs (each a
 * `fromEnv` name) and renders them into `.env` file content via `renderer`,
 * resolving each secret by name and failing loud on a missing one (the shared
 * {@link EnvFileRenderer} owns that resolution). Returns undefined for a
 * credential-free server. Pure — the edge writes the content to a scratch file.
 */
export function renderMcpCredentials(
  server: McpServer,
  renderer: EnvFileRenderer,
): string | undefined {
  if (server.requiredEnv.length === 0) return undefined;
  const entries: ContainerEnv[] = server.requiredEnv.map((name) => ({
    name,
    fromEnv: name,
  }));
  return renderer.render(entries, `MCP server "${server.name}"`);
}

/**
 * The complete plan for a spawn, as data — every effect the edge will perform,
 * decided purely. Credential and config *content* is rendered here (resolving
 * secrets by name, throwing on a missing one); the edge materializes that content
 * into scratch files and wires the resulting paths (ADR-0008).
 */
export interface SpawnPlan {
  /** Provider delivery (runtime env + optional baked config + runtime model), if any. */
  delivery?: ProviderDelivery;
  /** Rendered provider runtime env-file content (appended to the run's env-files). */
  providerEnvContent?: string;
  /** Container MCP sidecars to bring up (without their credential env-file, wired at execute). */
  sidecars: SidecarPlan[];
  /** Rendered credential env-file content per sidecar alias (for sidecars that need it). */
  sidecarCredentials: Record<string, string>;
  /** Rendered credential env-file content delivered to the agent (remote MCP servers). */
  remoteCredentials: string[];
  /** Extra argv wiring flag-delivered MCP into the harness (Claude's `--mcp-config`). */
  mcpArgs: string[];
  /** File-delivered MCP config overlay (Codex): the merged file, its mount, and env. */
  configOverlay?: ConfigOverlayDelivery;
  /** The derived agent image to build, or undefined to run the harness base directly. */
  agentImagePlan?: DerivedImagePlan;
  /** Read-only per-run skill mounts (outside `/workspace`). */
  skillMounts: Mount[];
  /** The agent container's `-e` env (user `-e` plus any config-dir relocation env). */
  agentEnv: string[];
  /** A runtime-resolved model to pass on the harness command line, when applicable. */
  runtimeModel?: string;
}

/**
 * Composes the whole {@link SpawnPlan} purely, given the gathered {@link
 * SpawnFacts} and the already-resolved model (undefined for a default agent). All
 * the branching that used to live inline in the spawn action — provider delivery,
 * MCP sidecar vs. remote vs. flag vs. file, the config overlay, the derived image,
 * skill mounts, and every credential env-file — is decided here, so the whole
 * thing is testable without a runtime, a container, or the network. Throws on a
 * missing credential (via {@link renderMcpCredentials}/{@link EnvFileRenderer}).
 */
export function planSpawn(facts: SpawnFacts, resolvedModel?: ResolvedModel): SpawnPlan {
  const { agent, harness, storeEnv, root } = facts;
  // One renderer, bound to the store's secrets, for every credential env-file this
  // spawn writes — the provider's and each MCP server's (ADR-0008).
  const envRenderer = new EnvFileRenderer((name) => storeEnv[name]);

  // Provider delivery (env harness → runtime env; file harness → baked config).
  let delivery: ProviderDelivery | undefined;
  let providerEnvContent: string | undefined;
  if (agent.provider && harness.adapter && resolvedModel) {
    delivery = planProviderDelivery(facts, harness.adapter, agent.provider, resolvedModel);
    providerEnvContent = envRenderer.render(delivery.runtimeEnv, 'Provider API key');
  }

  // MCP: split by transport, render credentials, decide the delivery form.
  const sidecars: SidecarPlan[] = [];
  const sidecarCredentials: Record<string, string> = {};
  const remoteCredentials: string[] = [];
  let mcpArgs: string[] = [];
  let configOverlay: ConfigOverlayDelivery | undefined;
  if (facts.mcpServers.length > 0) {
    const selection = planMcpSelection(facts.mcpServers);
    for (const server of selection.containerServers) {
      sidecars.push({
        alias: server.name,
        image: imageTag('mcp', server.name),
        port: server.port,
        healthcheck: server.healthcheck,
      });
      const creds = renderMcpCredentials(server, envRenderer);
      if (creds) sidecarCredentials[server.name] = creds;
    }
    for (const server of selection.remoteServers) {
      const creds = renderMcpCredentials(server, envRenderer);
      if (creds) remoteCredentials.push(creds);
    }
    // Claude takes MCP inline via a flag; a file harness (Codex) takes an overlay.
    // One decision names both the form and its wiring, so validate and plan agree.
    const mcp = planMcpDelivery(
      harness,
      selection.endpoints,
      delivery?.bakedConfig?.file.content ?? '',
    );
    if (mcp.form === 'flag') {
      mcpArgs = mcp.args;
    } else if (mcp.form === 'file') {
      configOverlay = mcp.overlay;
    }
  }

  // Per-run skill mounts (baked skills are handled by the derived image below).
  const skillMounts: Mount[] = [];
  if (facts.perRunSkills.length > 0 && harness.skillsDir) {
    for (const name of facts.perRunSkills) {
      skillMounts.push(skillMountSpec(skillDir(name, root), harness.skillsDir, name));
    }
  }

  // The derived agent image (baked provider config and/or baked default skills).
  const agentImagePlan = planAgentImage({
    baseImage: harness.imageTag,
    agentName: agent.name,
    bakedConfig: delivery?.bakedConfig,
    skills:
      facts.bakedSkills.length > 0 && harness.skillsDir
        ? { skillsDir: harness.skillsDir, names: facts.bakedSkills }
        : undefined,
  });

  return {
    delivery,
    providerEnvContent,
    sidecars,
    sidecarCredentials,
    remoteCredentials,
    mcpArgs,
    configOverlay,
    agentImagePlan,
    skillMounts,
    agentEnv: [...facts.env, ...(configOverlay?.env ?? [])],
    runtimeModel: delivery?.runtimeModel,
  };
}
