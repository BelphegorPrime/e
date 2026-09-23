import { NODE_HOME, type DockerfileParams } from './renderDockerfile.js';
import type { EnvHarnessSection } from './renderEnvTemplate.js';
import type {
  Protocol,
  HarnessAdapter,
  ConfigOverlayDelivery,
} from './adapter.js';
import type { McpEndpoint } from '../mcp/index.js';
import {
  claudeCodeAdapter,
  codexAdapter,
  opencodeAdapter,
  piAdapter,
  PI_PROVIDER_ID,
} from './adapter.js';
import { imageTag as eImageTag } from '../identity/imageTag.js';
import { SHIPPED_SKILL_COLLECTIONS } from '../skill/index.js';

/** A coding harness that runs inside a container built from its own Dockerfile. */
export interface Harness {
  /** Registry key, e.g. "claudeCode". */
  name: string;
  /** Tag for the image built from this harness's Dockerfile. */
  imageTag: string;
  /** Template parameters used to render this harness's Dockerfile. */
  dockerfile: DockerfileParams;
  /** Env vars this harness expects to find (typically supplied via --env-file). */
  requiredEnv: string[];
  /**
   * The wire protocols this harness speaks. A provider's protocol must be one of
   * these - see {@link validateProviderProtocol}. Grounding:
   * `docs/research/harness-cli-facts.md`.
   */
  protocols: readonly Protocol[];
  /**
   * The config adapter that renders a provider into this harness's native form
   * (env vars for an env-based harness). Absent until a harness has an adapter;
   * a default agent (no provider) never needs one.
   */
  adapter?: HarnessAdapter;
  /**
   * Builds the container argv that invokes the harness with the given prompt.
   * `model` is an optional runtime-resolved model to pass on the command line
   * (used by harnesses that take the model as a flag, e.g. Codex `-m`); harnesses
   * that carry the model via env or a baked config ignore it.
   */
  buildCommand(prompt: string, model?: string): string[];
  /**
   * Builds the argv for this harness's interactive TUI. `model` is supplied where
   * the harness supports selecting a runtime-resolved model on its command line.
   */
  buildInteractiveCommand(model?: string): string[];
  /**
   * Wires container MCP sidecar endpoints into this harness, returning the extra
   * argv to append to {@link buildCommand}. Present only for harnesses that take
   * MCP config inline via a flag (Claude Code's `--mcp-config`); absent for
   * harnesses that need a rendered config file or support no MCP - the spawn edge
   * capability-gates on its presence. Grounding: `docs/research/harness-cli-facts.md`.
   */
  renderMcpArgs?(endpoints: McpEndpoint[]): string[];
  /**
   * Absolute in-container directory this harness reads Agent Skills from, outside
   * `/workspace` so skills never land in a run's branch (e.g. Claude
   * `/home/node/.claude/skills`, the shared `/home/node/.agents/skills` for the
   * others). Its presence is the harness's declared skill capability; absent → `--skill`
   * and baked skills are rejected. Grounding: `docs/research/harness-cli-facts.md`.
   */
  skillsDir?: string;
}

/**
 * The shared in-container Agent-Skills directory read by Codex, opencode, and pi
 * (`~/.agents/skills`, under the home of the non-root `node` runtime user). Claude
 * Code reads its own `~/.claude/skills` instead. Grounding:
 * `docs/research/harness-cli-facts.md`.
 */
const AGENTS_SKILLS_DIR = `${NODE_HOME}/.agents/skills`;

/**
 * What keeps Claude Code from executing the configuration `/workspace` supplies
 * (#153). A `-p` session otherwise runs the hooks in the project's
 * `.claude/settings.json` and connects the servers in its `.mcp.json`, "even in
 * a folder you've never trusted" (its own headless docs) - and `e` mounts an
 * arbitrary repository there, so cloning one was enough for code execution
 * inside the run container, with no prompt injection and no agent decision.
 *
 * Measured on 2.1.267 against a stub endpoint, with a `SessionStart` hook in the
 * work directory's `.claude/settings.json`: the hook runs on a plain invocation
 * and on one carrying an unrelated `--settings` key, and does not run with
 * `disableAllHooks`. `--bare` also stops it, but it is not the flag to use here:
 * it cuts the tool set from 24 to `Bash, Edit, Read` - no `Write`, no `Skill`,
 * no web tools - which `--tools` does not lift, so it would take `e`'s own
 * Store-delivered skills (the ADR-0013 `spawn-brother` among them) away from
 * every Claude run.
 */
const CLAUDE_WORKSPACE_ISOLATION = [
  '--strict-mcp-config',
  '--settings',
  JSON.stringify({ disableAllHooks: true }),
] as const;

/** Available coding harnesses, keyed by name. */
export const HARNESSES: Record<string, Harness> = {
  pi: {
    name: 'pi',
    imageTag: eImageTag('harness', 'pi'),
    dockerfile: {
      label: 'Pi Coding Agent CLI harness.',
      npmPackage: '@earendil-works/pi-coding-agent',
      npmFlags: ['--ignore-scripts'],
      setupSteps: [
        'pi install npm:pi-mcp-adapter',
        'pi install npm:pi-web-access',
      ],
      skillCollections: SHIPPED_SKILL_COLLECTIONS,
      skillsAgent: 'pi',
    },
    requiredEnv: ['ANTHROPIC_API_KEY'],
    // pi speaks three wire protocols (its `openai-completions` is our
    // `openai-chat`). It is file-configured: a custom endpoint lives only in
    // `models.json` (no base-url env var), so the provider is delivered via the
    // file adapter, baked into the derived agent image. Grounding:
    // `docs/research/harness-cli-facts.md`, pi `docs/models.md`.
    protocols: ['openai-chat', 'openai-responses', 'anthropic-messages'],
    adapter: piAdapter,
    // pi selects a configured provider explicitly; the resolved model is passed
    // for selection when an agent declares a provider (a default agent runs
    // `pi -p <prompt>` and uses pi's own built-in default).
    // `--no-approve` is pi's half of the /workspace rule (#153): it ignores
    // project-local files for the run, so `/workspace/.pi/*`, project extensions
    // and project skills stay out. Nothing `e` delivers comes from there - its
    // skills are mounted under the runtime user's home - and the default
    // `defaultProjectTrust: "ask"` already behaves this way in non-interactive
    // mode, which makes this the rule for what was the default's doing.
    buildCommand: (prompt: string, model?: string) =>
      model
        ? [
            'pi',
            '--no-approve',
            '-p',
            prompt,
            '--provider',
            PI_PROVIDER_ID,
            '--model',
            model,
          ]
        : ['pi', '--no-approve', '-p', prompt],
    buildInteractiveCommand: (model?: string) =>
      model ? ['pi', '--provider', PI_PROVIDER_ID, '--model', model] : ['pi'],
    // pi reads Agent Skills from the shared `~/.agents/skills`.
    skillsDir: AGENTS_SKILLS_DIR,
  },
  claudeCode: {
    name: 'claudeCode',
    imageTag: eImageTag('harness', 'claudeCode'),
    dockerfile: {
      label: 'Claude Code CLI harness.',
      npmPackage: '@anthropic-ai/claude-code',
      skillCollections: SHIPPED_SKILL_COLLECTIONS,
      skillsAgent: 'claude-code',
      // Non-root runtime user (the template default); set `runtimeUser: 'root'`
      // here only if this CLI ever needs root at runtime (attack-surface.md Zone 1).
    },
    requiredEnv: ['ANTHROPIC_API_KEY'],
    // Claude Code speaks only the Anthropic Messages API and is configured via
    // env vars, so it carries the env-based adapter.
    protocols: ['anthropic-messages'],
    adapter: claudeCodeAdapter,
    buildCommand: (prompt: string) => [
      'claude',
      '-p',
      prompt,
      '--dangerously-skip-permissions',
      ...CLAUDE_WORKSPACE_ISOLATION,
    ],
    buildInteractiveCommand: () => [
      'claude',
      '--dangerously-skip-permissions',
      // The same posture attended: a project's hooks run at session start,
      // before anyone could look at what they did.
      ...CLAUDE_WORKSPACE_ISOLATION,
    ],
    // Claude takes MCP config inline: `--mcp-config '<json>'` with a streamable
    // HTTP server def per server (type "http"). No file, no restart. A remote
    // server may carry auth headers whose `${VAR}` values Claude expands from the
    // container env at runtime, so the secret is never written onto argv.
    renderMcpArgs: (endpoints: McpEndpoint[]) => {
      if (endpoints.length === 0) return [];
      type HttpServer = {
        type: 'http';
        url: string;
        headers?: Record<string, string>;
      };
      const mcpServers: Record<string, HttpServer> = {};
      for (const endpoint of endpoints) {
        const server: HttpServer = { type: 'http', url: endpoint.url };
        if (endpoint.headers) server.headers = endpoint.headers;
        mcpServers[endpoint.name] = server;
      }
      return ['--mcp-config', JSON.stringify({ mcpServers })];
    },
    // Claude Code reads Agent Skills from `~/.claude/skills` (not `.agents/`).
    skillsDir: `${NODE_HOME}/.claude/skills`,
  },
  codex: {
    name: 'codex',
    imageTag: eImageTag('harness', 'codex'),
    dockerfile: {
      label: 'OpenAI Codex CLI harness.',
      npmPackage: '@openai/codex',
      skillCollections: SHIPPED_SKILL_COLLECTIONS,
      skillsAgent: 'codex',
    },
    requiredEnv: ['OPENAI_API_KEY'],
    // Codex speaks only OpenAI Responses (`/v1/chat/completions` was removed).
    protocols: ['openai-responses'],
    // Codex is file-configured (`config.toml`): its adapter renders the provider
    // block into a derived agent image (ADR-0004/0006). An auto-resolved model
    // arrives at runtime as `-m <id>` (a baked concrete model needs no flag).
    adapter: codexAdapter,
    buildCommand: (prompt: string, model?: string) => [
      'codex',
      'exec',
      // `codex exec` defaults to a READ-ONLY sandbox (its approval policy is
      // already `never`), so without this the run cannot write /workspace and
      // exits 0 regardless. The container is the isolation boundary
      // (ADR-0002/0011), the posture this flag assumes; it also implies
      // `--skip-git-repo-check` and keeps exec's headless `never` policy.
      // Grounding: `docs/research/harness-unattended-flags.md`.
      '--dangerously-bypass-approvals-and-sandbox',
      // `.rules` (execpolicy) files are read from `/workspace` as well as from
      // CODEX_HOME. A project's can only restrict what the run may do, so the
      // exposure is sabotage rather than execution; `e` ships none of its own,
      // so ignoring both layers costs nothing today - the day `e` delivers a
      // `.rules` file through the Store overlay, this flag has to go (#153). What this cannot reach is the project's
      // `.codex/config.toml`, which is loaded with no trust gate and can start
      // MCP servers - no flag suppresses it at 0.147.0. Its hooks are gated,
      // and stay gated: `--dangerously-bypass-hook-trust` is never passed.
      // See `docs/security/attack-surface.md`.
      '--ignore-rules',
      ...(model ? ['-m', model] : []),
      prompt,
    ],
    buildInteractiveCommand: (model?: string) =>
      model ? ['codex', '-m', model] : ['codex'],
    // Codex reads Agent Skills from the shared `~/.agents/skills`.
    skillsDir: AGENTS_SKILLS_DIR,
  },
  opencode: {
    name: 'opencode',
    imageTag: eImageTag('harness', 'opencode'),
    dockerfile: {
      label: 'opencode CLI harness.',
      npmPackage: 'opencode-ai',
      skillCollections: SHIPPED_SKILL_COLLECTIONS,
      skillsAgent: 'opencode',
    },
    requiredEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    // opencode (Vercel AI SDK) speaks all three via its provider plugins.
    protocols: ['openai-chat', 'openai-responses', 'anthropic-messages'],
    // opencode is file-configured (`opencode.json` under OPENCODE_CONFIG_DIR);
    // the model arrives at runtime as `-m e/<model>`.
    adapter: opencodeAdapter,
    buildCommand: (prompt: string, model?: string) => [
      'opencode',
      'run',
      // `opencode run` never prompts - it auto-REJECTS what resolves to `ask`
      // (`external_directory` fires on any path outside cwd) and exits 0 having
      // done less. `--auto` approves what is not explicitly denied. Grounding:
      // `docs/research/harness-unattended-flags.md`.
      '--auto',
      ...(model ? ['-m', model] : []),
      prompt,
    ],
    buildInteractiveCommand: (model?: string) =>
      model ? ['opencode', '-m', model] : ['opencode'],
    // opencode reads Agent Skills from the shared `~/.agents/skills`.
    skillsDir: AGENTS_SKILLS_DIR,
  },
};

/**
 * Resolves a harness by name, throwing with the list of valid names if unknown.
 */
export function resolveHarness(name: string): Harness {
  const harness = HARNESSES[name];
  if (!harness) {
    throw new Error(
      `Unknown harness "${name}". Valid values: ${Object.keys(HARNESSES).join(', ')}.`
    );
  }
  return harness;
}

/**
 * How a harness accepts MCP server config, its declared MCP capability (ADR-0006):
 *  - `flag` - inline on the command line (Claude Code's `--mcp-config`).
 *  - `file` - rendered into its native config file, delivered as a runtime
 *    overlay via its file adapter (Codex's `config.toml` / `CODEX_HOME`; pi's
 *    `mcp.json` via the pi-mcp-adapter extension).
 *  - `none` - no MCP client at all or no MCP delivery wired yet (opencode);
 *    `--mcp` is rejected with a clear error at spawn.
 */
export type McpDeliveryForm = 'flag' | 'file' | 'none';

/**
 * A harness's MCP wiring: the delivery form *and* the very function that form
 * calls, bound to its owner. Probing once and carrying the capability away is
 * what keeps {@link planMcpDelivery} free of casts and non-null assertions - a
 * label alone would force every caller to re-prove what the probe already knew.
 * Internal to this module.
 */
type McpWiring =
  | { form: 'flag'; renderArgs: (endpoints: McpEndpoint[]) => string[] }
  | {
      form: 'file';
      planOverlay: (
        baseConfig: string,
        endpoints: McpEndpoint[]
      ) => ConfigOverlayDelivery;
    }
  | { form: 'none' };

/**
 * The single classifier of the `flag`/`file`/`none` fork. Both
 * {@link harnessCapabilities} (for gating) and {@link planMcpDelivery} (for
 * wiring) go through it, so the label and the wiring it implies can never
 * disagree.
 */
function mcpWiring(harness: Harness): McpWiring {
  if (harness.renderMcpArgs) {
    return { form: 'flag', renderArgs: harness.renderMcpArgs.bind(harness) };
  }
  // A file adapter delivers MCP only if it plans an overlay; opencode's plans
  // none yet, so it stays `none`.
  const adapter = harness.adapter;
  if (adapter?.kind === 'file' && adapter.planConfigOverlay) {
    return {
      form: 'file',
      planOverlay: adapter.planConfigOverlay.bind(adapter),
    };
  }
  return { form: 'none' };
}

/** The MCP delivery form a harness declares - {@link mcpWiring} without its wiring. */
function mcpDeliveryForm(harness: Harness): McpDeliveryForm {
  return mcpWiring(harness).form;
}

/**
 * What a harness can do, as a small described value - the presence/form gates the
 * spawn edge checks before a run (ADR-0006/0008). It replaces the scatter of
 * optional-field probes (`adapter?`, `renderMcpArgs?`, `skillsDir?`) that
 * `validateSpawn` used to reassemble by hand: each field states one capability.
 * Gating only - `planSpawn` still fetches the real `adapter` and calls
 * {@link planMcpDelivery} for the wiring a form implies. (Protocol compatibility
 * is a set-membership check with its own home, `validateProviderProtocol`, so it
 * is deliberately not a capability here.)
 */
export interface HarnessCapabilities {
  /** How a provider is delivered: env vars, a baked config file, or no adapter. */
  provider: 'env' | 'file' | 'none';
  /** How MCP config is delivered (see {@link McpDeliveryForm}). */
  mcp: McpDeliveryForm;
  /** The in-container skills dir, or undefined when the harness supports no skills. */
  skills: string | undefined;
}

/** Describes a harness's capabilities for the spawn edge's gating (see {@link HarnessCapabilities}). */
export function harnessCapabilities(harness: Harness): HarnessCapabilities {
  return {
    provider: harness.adapter ? harness.adapter.kind : 'none',
    mcp: mcpDeliveryForm(harness),
    skills: harness.skillsDir,
  };
}

/**
 * How the selected MCP servers reach a harness, as data - the wiring a
 * {@link McpDeliveryForm} implies, decided in one place so `planSpawn` no longer
 * re-branches on `renderMcpArgs` vs the file adapter (ADR-0006):
 *  - `flag` - extra argv for the run command (Claude's `--mcp-config`).
 *  - `file` - a config overlay merged onto `baseConfig` (Codex's `config.toml`).
 *  - `none` - no delivery; the spawn edge rejects `--mcp` against such a harness
 *    before ever calling this, so it is unreachable in a valid run (defensive).
 */
export type McpDelivery =
  | { form: 'flag'; args: string[] }
  | { form: 'file'; overlay: ConfigOverlayDelivery }
  | { form: 'none' };

/**
 * Plans MCP delivery for a harness, given the selected `endpoints` and the baked
 * provider `baseConfig` a file overlay merges onto (empty for a default agent).
 * Dispatches on the single {@link mcpWiring} classifier - the label and the wiring
 * share one source, so they cannot drift, and the capability arrives already
 * proven rather than re-probed here.
 */
export function planMcpDelivery(
  harness: Harness,
  endpoints: McpEndpoint[],
  baseConfig: string
): McpDelivery {
  const wiring = mcpWiring(harness);
  switch (wiring.form) {
    case 'flag':
      return { form: wiring.form, args: wiring.renderArgs(endpoints) };
    case 'file':
      return {
        form: wiring.form,
        overlay: wiring.planOverlay(baseConfig, endpoints),
      };
    case 'none':
      return { form: wiring.form };
  }
}

/**
 * Builds the per-harness sections for the shared `.env` template - one entry
 * per harness, carrying that harness's `requiredEnv` verbatim (no dedup).
 */
export function envHarnessSections(): EnvHarnessSection[] {
  return Object.values(HARNESSES).map(harness => ({
    name: harness.name,
    env: harness.requiredEnv,
  }));
}

/**
 * The deduped union of every harness's `requiredEnv` - the set of API keys
 * `e init` collects into `.e/.env`, in first-seen order across the registry.
 */
export function requiredEnvKeys(): string[] {
  const optionalEnvKeys = ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL'];

  const seen = new Set<string>(optionalEnvKeys);

  for (const harness of Object.values(HARNESSES)) {
    for (const key of harness.requiredEnv) {
      seen.add(key);
    }
  }

  return [...seen];
}
