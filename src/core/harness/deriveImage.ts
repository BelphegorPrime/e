/**
 * Rendering and planning for a **derived agent image** - ADR-0004 layer 2. A
 * derived image is a thin layer built `FROM` the shared harness base that bakes
 * an agent's static configuration: a file-configured harness's provider config
 * (Codex) and/or an agent's default Skills. The base's CLI/toolchain layers are
 * reused, so only the cheap config layer rebuilds when an agent's config changes.
 *
 * This module is pure: it renders the derived Dockerfile, the image tag, the
 * provider-delivery plan, and the composed derived-image plan. The spawn edge
 * performs the effects (writing files, copying skill trees, invoking the build).
 */
import type {
  BakedProviderConfig,
  ContainerEnv,
  HarnessAdapter,
  Provider,
  RenderedConfigFile,
} from './adapter.js';
import { imageTag } from '../identity/imageTag.js';
import { NODE_HOME } from './renderDockerfile.js';

/** The baked default-skills block of a derived Dockerfile. */
export interface DockerfileSkillsBlock {
  /** Absolute in-container skills dir the trees are copied into; outside `/workspace`. */
  skillsDir: string;
  /** Skill names copied from `skills/<name>/` in the build context. */
  names: readonly string[];
}

/** Inputs for rendering a derived agent Dockerfile - either or both blocks may be present. */
export interface DerivedDockerfileParams {
  /** The harness base image tag this derives from, e.g. `e-harness-codex`. */
  baseImage: string;
  /**
   * The baked provider config, for a file-configured harness - the adapter's own
   * {@link BakedProviderConfig}, passed through rather than re-flattened: the
   * render needs its file name and its two config-dir fields.
   */
  provider?: BakedProviderConfig;
  /** The baked default skills, for an agent that declares them. */
  skills?: DockerfileSkillsBlock;
  /**
   * The container user the harness base runs as (the harness's
   * `DockerfileParams.runtimeUser`, default `'node'`). The derived image must
   * match it at the end, and must build its COPY layers in a way the runtime
   * user can then write - see {@link renderDerivedDockerfile}.
   */
  runtimeUser?: 'node' | 'root';
}

/**
 * Renders a derived agent Dockerfile: `FROM` the harness base, then - as declared
 * - a provider block (relocate the config dir via its env var and `COPY` the
 * rendered config file into it) and/or a skills block (`COPY` each skill tree into
 * the harness's skills dir). Every `COPY` target lands outside `/workspace`, so
 * `e`-generated config and skills never pollute the Run's branch (ADR-0006). The
 * API key is *not* baked - the config file references it by name.
 *
 * The base image ends with the harness's runtime user (`USER node` for the
 * non-root default - attack-surface.md Zone 1). The COPY layers must therefore
 * build as root (a non-root build step cannot reliably create root-owned parents
 * across builders) and then hand the copied trees back to the runtime user, so a
 * CLI that writes to its config dir at runtime (Codex history/log under
 * `CODEX_HOME`, pi sessions/trust under `PI_CODING_AGENT_DIR`) can. A `root`
 * runtime-user harness skips the whole escalation - the base already ends as
 * root and COPY layers are free to run as root.
 */
export function renderDerivedDockerfile(p: DerivedDockerfileParams): string {
  const nonRoot = (p.runtimeUser ?? 'node') !== 'root';
  const lines: string[] = [`FROM ${p.baseImage}`];
  // Trees the derived image copies in; handed back to the runtime user after
  // the build step, so their runtime writes (history, sessions, auth) succeed.
  const ownedDirs: string[] = [NODE_HOME];
  let escalated = false;

  const startBlock = () => {
    lines.push('');
    if (nonRoot && !escalated) {
      lines.push('USER root');
      escalated = true;
    }
  };

  if (p.provider) {
    startBlock();
    lines.push(
      `# Baked agent config (ADR-0004 layer 2): the provider block rendered by`,
      `# the harness adapter, read from a config dir outside /workspace so it`,
      `# never lands in a run's branch.`,
      `ENV ${p.provider.configDirEnv}=${p.provider.configDir}`,
      `COPY ${p.provider.file.fileName} ${p.provider.configDir}/${p.provider.file.fileName}`
    );
    ownedDirs.push(p.provider.configDir);
  }

  if (p.skills && p.skills.names.length > 0) {
    startBlock();
    lines.push(
      `# Baked default skills (ADR-0006): each skill tree copied into the harness's`,
      `# skills dir outside /workspace so it never lands in a run's branch.`
    );
    for (const name of p.skills.names) {
      lines.push(`COPY skills/${name}/ ${p.skills.skillsDir}/${name}/`);
    }
    ownedDirs.push(p.skills.skillsDir);
  }

  if (nonRoot && ownedDirs.length > 0) {
    const user = 'node';
    lines.push(
      '',
      `RUN chown -R ${user}:${user} ${ownedDirs.join(' ')}`,
      `USER ${user}`
    );
  }

  return lines.join('\n') + '\n';
}

/**
 * The image tag for an agent's derived image. Namespaced `e-agent-*`, distinct
 * from the `e-harness-*` base tags so an agent image never collides with the
 * harness image it derives from.
 */
export function derivedImageTag(agentName: string): string {
  return imageTag('agent', agentName);
}

/**
 * How a Provider is delivered to a Run: a {@link FileProviderDelivery} widened by
 * the one thing an env harness differs in - it bakes nothing, so `bakedConfig` is
 * optional here and required there.
 */
export interface ProviderDelivery {
  /**
   * Env delivered at runtime via `--env-file`: the API key by name for every
   * harness, plus - for an env-configured harness - the endpoint and the model.
   */
  runtimeEnv: ContainerEnv[];
  /**
   * A model to name on the run command (e.g. `codex exec -m <id>`), when the
   * harness needs it there; see {@link FileProviderDelivery.runtimeModel}. Never
   * set for an env harness, which carries its model in the env.
   */
  runtimeModel?: string;
  /**
   * Present only for a file-configured harness: the provider config to bake into
   * the derived agent image (composed with any default skills by
   * {@link planAgentImage}).
   */
  bakedConfig?: BakedProviderConfig;
}

/**
 * Plans how an agent's {@link Provider} reaches its Run - the union's one fork,
 * and the whole of what this module decides about an adapter:
 *
 * - **env** harness (Claude Code): the whole provider becomes runtime env;
 *   nothing is baked.
 * - **file** harness (Codex, pi): the adapter plans its own delivery. What gets
 *   baked, where it lands in the image, and whether the run command must name the
 *   model are that harness's business, not this module's (ADR-0006).
 */
export function planProviderDelivery(
  storeEnv: Record<string, string>,
  adapter: HarnessAdapter,
  provider: Provider
): ProviderDelivery {
  return adapter.kind === 'env'
    ? { runtimeEnv: adapter.renderProviderEnv(provider) }
    : adapter.planProviderDelivery(provider, storeEnv);
}

/** The derived agent image, composing baked provider config and/or default skills. */
export interface DerivedImagePlan {
  /** Tag of the derived image, built on and running instead of the harness base. */
  imageTag: string;
  /**
   * Rendered files to write under `.e/agents/<name>/` - the provider config file
   * (if any) plus the derived Dockerfile - never clobbering a hand edit. The
   * agent dir seeds the build context so the Dockerfile's `COPY` finds them.
   */
  files: RenderedConfigFile[];
  /**
   * Baked skill names. Their trees are copied from the Store's `skills/<name>/`
   * into the build context at `skills/<name>/` by the spawn edge (they are file
   * trees, not rendered strings, so they are not in {@link files}).
   */
  skillNames: readonly string[];
}

/**
 * Composes an agent's derived image, purely - the single place baked provider
 * config and baked default skills are combined into one thin layer-2 image
 * `FROM` the harness base. Returns `undefined` when there is nothing to bake (no
 * provider config and no skills), so the run uses the harness base directly.
 * `runtimeUser` is the harness's runtime user (default `'node'`), forwarded to
 * the derived render so its COPY layers hand ownership back to the user the
 * base image ends with.
 */
export function planAgentImage(params: {
  baseImage: string;
  agentName: string;
  bakedConfig?: BakedProviderConfig;
  skills?: { skillsDir: string; names: readonly string[] };
  runtimeUser?: 'node' | 'root';
}): DerivedImagePlan | undefined {
  const skillNames = params.skills?.names ?? [];
  if (!params.bakedConfig && skillNames.length === 0) return undefined;

  const files: RenderedConfigFile[] = [];
  if (params.bakedConfig) files.push(params.bakedConfig.file);

  files.push({
    fileName: 'Dockerfile',
    content: renderDerivedDockerfile({
      baseImage: params.baseImage,
      provider: params.bakedConfig,
      skills: skillNames.length > 0 ? params.skills : undefined,
      runtimeUser: params.runtimeUser,
    }),
  });

  return { imageTag: derivedImageTag(params.agentName), files, skillNames };
}
