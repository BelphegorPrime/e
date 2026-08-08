/**
 * Rendering and planning for a **derived agent image** — ADR-0004 layer 2. A
 * file-configured harness (Codex) bakes its provider config into a thin image
 * built `FROM` the shared harness base, so the base's CLI/toolchain layers are
 * reused and only the cheap config layer is rebuilt when an agent's static
 * config changes.
 *
 * This module is pure: it renders the derived Dockerfile, the image tag, and the
 * whole provider-delivery plan. The spawn edge performs the effects (writing the
 * files, invoking the runtime build), just as it does for harness Dockerfiles.
 */
import type {
  ContainerEnv,
  HarnessAdapter,
  Provider,
  RenderedConfigFile,
} from './adapter';

/** Inputs for rendering a derived agent Dockerfile. */
export interface DerivedDockerfileParams {
  /** The harness base image tag this derives from, e.g. `e-harness-codex`. */
  baseImage: string;
  /** The rendered config file's name, present in the build context. */
  configFileName: string;
  /** Absolute in-container config dir the file is copied into; outside `/workspace`. */
  configDir: string;
  /** Name of the env var relocating the config dir, e.g. `CODEX_HOME`. */
  configDirEnv: string;
}

/**
 * Renders a derived agent Dockerfile: `FROM` the harness base, relocate the
 * harness's config dir via its env var, and `COPY` the rendered config file into
 * it. The config lands outside `/workspace`, so `e`-generated config never
 * pollutes the Run's branch (ADR-0006). The API key is *not* baked — the config
 * file references it by name and it is injected at runtime.
 */
export function renderDerivedDockerfile(p: DerivedDockerfileParams): string {
  return (
    [
      `FROM ${p.baseImage}`,
      ``,
      `# Baked agent config (ADR-0004 layer 2): the provider block rendered by`,
      `# the harness adapter, read from a config dir outside /workspace so it`,
      `# never lands in a run's branch.`,
      `ENV ${p.configDirEnv}=${p.configDir}`,
      `COPY ${p.configFileName} ${p.configDir}/${p.configFileName}`,
    ].join('\n') + '\n'
  );
}

/**
 * The image tag for an agent's derived image. Namespaced `e-agent-*`, distinct
 * from the `e-harness-*` base tags so an agent image never collides with the
 * harness image it derives from.
 */
export function derivedImageTag(agentName: string): string {
  return `e-agent-${agentName}`;
}

/** The derived agent image a file-configured provider is delivered through. */
export interface DerivedImagePlan {
  /** Tag of the derived image, built on and running instead of the harness base. */
  imageTag: string;
  /**
   * Files to render under `.e/agents/<name>/` — the harness's config file plus
   * the derived Dockerfile — never clobbering a hand edit. The agent dir is the
   * build context, so the Dockerfile's `COPY` finds the config file beside it.
   */
  files: RenderedConfigFile[];
}

/** How a Provider is delivered to a Run: runtime env, plus a derived image for a file harness. */
export interface ProviderDelivery {
  /**
   * Env delivered at runtime via `--env-file`: the API key by name for every
   * harness, plus — for an env-configured harness — the endpoint and model.
   */
  runtimeEnv: ContainerEnv[];
  /** Present only for a file-configured harness: the derived image to build and run. */
  derived?: DerivedImagePlan;
}

/**
 * Plans how an agent's {@link Provider} reaches its Run, purely — the single
 * place the delivery form is decided from the adapter's kind:
 *
 * - **env** harness (Claude Code): the whole provider becomes runtime env; no
 *   image is derived and the harness base runs directly.
 * - **file** harness (Codex): the provider is rendered into a config file and a
 *   derived Dockerfile baked on the harness base, and only the API key is
 *   delivered at runtime (by name; never baked).
 *
 * The spawn edge executes the plan (writes {@link DerivedImagePlan.files},
 * builds the image, layers the runtime env-file); this function does no I/O, so
 * the selection and the rendered artifacts are testable without a runtime.
 */
export function planProviderDelivery(
  adapter: HarnessAdapter,
  provider: Provider,
  opts: { agentName: string; baseImage: string },
): ProviderDelivery {
  if (adapter.kind === 'env') {
    return { runtimeEnv: adapter.renderProviderEnv(provider) };
  }
  const config = adapter.renderProviderFile(provider);
  const dockerfile: RenderedConfigFile = {
    fileName: 'Dockerfile',
    content: renderDerivedDockerfile({
      baseImage: opts.baseImage,
      configFileName: config.fileName,
      configDir: adapter.configDir,
      configDirEnv: adapter.configDirEnv,
    }),
  };
  return {
    runtimeEnv: adapter.renderRuntimeEnv(provider),
    derived: {
      imageTag: derivedImageTag(opts.agentName),
      files: [config, dockerfile],
    },
  };
}
