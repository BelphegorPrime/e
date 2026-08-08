/**
 * Rendering and planning for a **derived agent image** — ADR-0004 layer 2. A
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
  ContainerEnv,
  HarnessAdapter,
  Provider,
  RenderedConfigFile,
} from './adapter';
import type { ResolvedModel } from '../model/resolve';
import { imageTag } from '../naming';

/** The baked provider config block of a derived Dockerfile (a file harness). */
export interface DockerfileProviderBlock {
  /** The rendered config file's name, present in the build context. */
  configFileName: string;
  /** Absolute in-container config dir the file is copied into; outside `/workspace`. */
  configDir: string;
  /** Name of the env var relocating the config dir, e.g. `CODEX_HOME`. */
  configDirEnv: string;
}

/** The baked default-skills block of a derived Dockerfile. */
export interface DockerfileSkillsBlock {
  /** Absolute in-container skills dir the trees are copied into; outside `/workspace`. */
  skillsDir: string;
  /** Skill names copied from `skills/<name>/` in the build context. */
  names: string[];
}

/** Inputs for rendering a derived agent Dockerfile — either or both blocks may be present. */
export interface DerivedDockerfileParams {
  /** The harness base image tag this derives from, e.g. `e-harness-codex`. */
  baseImage: string;
  /** The baked provider config, for a file-configured harness. */
  provider?: DockerfileProviderBlock;
  /** The baked default skills, for an agent that declares them. */
  skills?: DockerfileSkillsBlock;
}

/**
 * Renders a derived agent Dockerfile: `FROM` the harness base, then — as declared
 * — a provider block (relocate the config dir via its env var and `COPY` the
 * rendered config file into it) and/or a skills block (`COPY` each skill tree into
 * the harness's skills dir). Every `COPY` target lands outside `/workspace`, so
 * `e`-generated config and skills never pollute the Run's branch (ADR-0006). The
 * API key is *not* baked — the config file references it by name.
 */
export function renderDerivedDockerfile(p: DerivedDockerfileParams): string {
  const lines: string[] = [`FROM ${p.baseImage}`];

  if (p.provider) {
    lines.push(
      ``,
      `# Baked agent config (ADR-0004 layer 2): the provider block rendered by`,
      `# the harness adapter, read from a config dir outside /workspace so it`,
      `# never lands in a run's branch.`,
      `ENV ${p.provider.configDirEnv}=${p.provider.configDir}`,
      `COPY ${p.provider.configFileName} ${p.provider.configDir}/${p.provider.configFileName}`,
    );
  }

  if (p.skills && p.skills.names.length > 0) {
    lines.push(
      ``,
      `# Baked default skills (ADR-0006): each skill tree copied into the harness's`,
      `# skills dir outside /workspace so it never lands in a run's branch.`,
    );
    for (const name of p.skills.names) {
      lines.push(`COPY skills/${name}/ ${p.skills.skillsDir}/${name}/`);
    }
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

/** A file-configured harness's provider config, baked into the derived image. */
export interface BakedProviderConfig {
  /** The rendered config file (e.g. Codex `config.toml`). */
  file: RenderedConfigFile;
  /** Absolute in-container config dir the file is baked into; outside `/workspace`. */
  configDir: string;
  /** Name of the env var relocating the config dir, e.g. `CODEX_HOME`. */
  configDirEnv: string;
}

/** How a Provider is delivered to a Run. */
export interface ProviderDelivery {
  /**
   * Env delivered at runtime via `--env-file`: the API key by name for every
   * harness, plus — for an env-configured harness — the endpoint and resolved model.
   */
  runtimeEnv: ContainerEnv[];
  /**
   * A model to deliver on the run command (e.g. `codex exec -m <id>`), set only
   * when the model was `auto`-resolved for a file harness — its config file omits
   * the model so the resolved id arrives at runtime, not baked (ADR-0007).
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
 * Plans how an agent's {@link Provider} reaches its Run, purely — the single
 * place the delivery form is decided from the adapter's kind, given the model
 * already {@link ResolvedModel resolved} at spawn:
 *
 * - **env** harness (Claude Code): the whole provider (with the resolved model)
 *   becomes runtime env; nothing is baked from the provider.
 * - **file** harness (Codex, pi): the provider is rendered into a config file to
 *   bake into the derived image ({@link ProviderDelivery.bakedConfig}). The model
 *   handling branches on the adapter's `modelInFile`: Codex (`false`) bakes a
 *   concrete model but keeps an `auto`-resolved one out of the config and delivers
 *   it on the run command (`runtimeModel`); pi (`true`) selects only models
 *   declared in `models.json`, so the resolved model is always baked *and* passed
 *   on the command line (`--provider`/`--model`) for selection. Only the API key
 *   is delivered as runtime env (by name; never baked).
 */
export function planProviderDelivery(
  adapter: HarnessAdapter,
  provider: Provider,
  resolved: ResolvedModel,
): ProviderDelivery {
  if (adapter.kind === 'env') {
    // Env harnesses carry the model at runtime already; use the resolved id.
    return { runtimeEnv: adapter.renderProviderEnv({ ...provider, model: resolved.model }) };
  }

  // File harness: bake the provider config into the derived image. `modelInFile`
  // forces the resolved model into the config (pi requires it declared to be
  // selectable) and passes it on the command line too; otherwise Codex keeps an
  // auto model out of the config and delivers it via `-m` at runtime.
  const bakeResolvedModel = adapter.modelInFile || !resolved.fromAuto;
  const passModelOnCommand = adapter.modelInFile || resolved.fromAuto;
  const configProvider: Provider = bakeResolvedModel
    ? { ...provider, model: resolved.model }
    : provider;
  return {
    runtimeEnv: adapter.renderRuntimeEnv(provider),
    runtimeModel: passModelOnCommand ? resolved.model : undefined,
    bakedConfig: {
      file: adapter.renderProviderFile(configProvider),
      configDir: adapter.configDir,
      configDirEnv: adapter.configDirEnv,
    },
  };
}

/** The derived agent image, composing baked provider config and/or default skills. */
export interface DerivedImagePlan {
  /** Tag of the derived image, built on and running instead of the harness base. */
  imageTag: string;
  /**
   * Rendered files to write under `.e/agents/<name>/` — the provider config file
   * (if any) plus the derived Dockerfile — never clobbering a hand edit. The
   * agent dir seeds the build context so the Dockerfile's `COPY` finds them.
   */
  files: RenderedConfigFile[];
  /**
   * Baked skill names. Their trees are copied from the Store's `skills/<name>/`
   * into the build context at `skills/<name>/` by the spawn edge (they are file
   * trees, not rendered strings, so they are not in {@link files}).
   */
  skillNames: string[];
}

/**
 * Composes an agent's derived image, purely — the single place baked provider
 * config and baked default skills are combined into one thin layer-2 image
 * `FROM` the harness base. Returns `undefined` when there is nothing to bake (no
 * provider config and no skills), so the run uses the harness base directly.
 */
export function planAgentImage(params: {
  baseImage: string;
  agentName: string;
  bakedConfig?: BakedProviderConfig;
  skills?: { skillsDir: string; names: string[] };
}): DerivedImagePlan | undefined {
  const skillNames = params.skills?.names ?? [];
  if (!params.bakedConfig && skillNames.length === 0) return undefined;

  const files: RenderedConfigFile[] = [];
  const provider: DockerfileProviderBlock | undefined = params.bakedConfig
    ? {
        configFileName: params.bakedConfig.file.fileName,
        configDir: params.bakedConfig.configDir,
        configDirEnv: params.bakedConfig.configDirEnv,
      }
    : undefined;
  if (params.bakedConfig) files.push(params.bakedConfig.file);

  files.push({
    fileName: 'Dockerfile',
    content: renderDerivedDockerfile({
      baseImage: params.baseImage,
      provider,
      skills:
        skillNames.length > 0
          ? { skillsDir: params.skills!.skillsDir, names: skillNames }
          : undefined,
    }),
  });

  return { imageTag: derivedImageTag(params.agentName), files, skillNames };
}
