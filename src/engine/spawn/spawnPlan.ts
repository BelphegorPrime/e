/**
 * Pure decisions behind the `spawn` command. The command action stays a thin
 * edge that performs the I/O (filesystem, runtime) and effects (`process.exit`,
 * `console`); the branching logic that decides *what* to do lives here so it can
 * be tested directly, without building an image or running a container.
 *
 * The edge gathers {@link SpawnFacts} (all I/O), then: {@link validateSpawn}
 * (pure, fail-fast) → resolve the model (the one remaining I/O) → {@link
 * planSpawn} (pure) → execute the returned {@link SpawnPlan}. Everything that
 * decides *what* the run is - including rendering every credential env-file and
 * throwing on a missing secret - happens purely here; the edge only performs the
 * effects the plan names (ADR-0008).
 */

import type { HarnessAgent } from '../../core/agent/index.js';
import type { Harness } from '../../core/harness/index.js';
import {
  harnessCapabilities,
  planMcpDelivery,
  resumableHarnessNames,
} from '../../core/harness/index.js';
import {
  validateProviderProtocol,
  EnvFileRenderer,
} from '../../core/harness/adapter.js';
import type {
  ConfigOverlayDelivery,
  ContainerEnv,
} from '../../core/harness/adapter.js';
import {
  GLOBAL_BASE_URL_ENV,
  NEVER_FORWARDED_ENV,
} from '../../core/harness/renderEnvTemplate.js';
import {
  planProviderDelivery,
  planAgentImage,
  type ProviderDelivery,
  type DerivedImagePlan,
} from '../../core/harness/deriveImage.js';
import { planMcpSelection, type McpServer } from '../../core/mcp/index.js';
import type { Mount } from '../../core/mount.js';
import type { SiblingSpawn } from '../../shared/utils/env.js';
import type { LocalRuntime } from '../../core/localRuntimes.js';
import type {
  GitPlatform,
  LoopCaps,
  ResourceCaps,
  VerifyConfig,
} from '../../core/store/config.js';
import {
  defaultBrokerPlan,
  type BrokerPlan,
  type SidecarPlan,
} from '../sidecarPlan.js';
import { SPAWN_BROTHER_SKILL } from '../../sidecars/broker/contract/constants.js';
import {
  brokerUrl,
  isRoleContractEntry,
  roleEnv,
  type RunRole,
} from '../runRole.js';
import { imageTag } from '../../core/identity/imageTag.js';
import { skillMountSpec } from '../../core/skill/index.js';
import { skillDir } from '../../core/store/paths.js';
import { EVENT_MOUNT_PATH } from '../../core/trigger/oneShot.js';
import type { Provenance } from '../../core/trigger/provenance.js';
import type { ResumeRun, RunBase } from '../runs/runSpawn.js';
import { sessionProvider, type RunSessionInit } from '../runs/runSession.js';

/**
 * The env files a run loads, in precedence order. `--env-file` entries loaded
 * later override earlier ones for the same key, so the shared base `.e/.env`
 * comes first and the user's `--env-file` second. Absent inputs are dropped;
 * the caller decides presence (the base file must exist on disk, the user file
 * is whatever `--env-file` was given).
 */
export function orderEnvFiles(
  baseEnvPath: string | undefined,
  userEnvFile: string | undefined
): string[] {
  const files: string[] = [];
  if (baseEnvPath !== undefined) files.push(baseEnvPath);
  if (userEnvFile !== undefined) files.push(userEnvFile);
  return files;
}

/** Inputs to the image-build gate; all pre-resolved by the caller. */
export interface ImageActionInput {
  /** Always (re)build: the default, off only with `--no-rebuild`. */
  rebuild: boolean;
  /** An image with the harness's tag already exists locally. */
  imageExists: boolean;
  /** `e init` has written this harness's Dockerfile under the resolved root. */
  initialized: boolean;
  /**
   * The existing image carries the harness's version pin in its labels
   * (ADR-0016 section 10). An image that does not is rebuilt, never run:
   * its argv was verified against another version, or against none.
   */
  pinned: boolean;
}

/**
 * Decides what a spawn should do about the harness image before running:
 *
 * - `skip` - a usable image is already present, built from the pinned
 *   version, and `--no-rebuild` turned the default rebuild off.
 * - `build` - an image is needed and the harness is initialized (has a Dockerfile).
 * - `not-initialized` - an image is needed but the harness has no Dockerfile;
 *   the caller surfaces the "run `e init`" error.
 *
 * The caller performs the effect the decision names; this function does no I/O.
 */
export function decideImageAction({
  rebuild,
  imageExists,
  initialized,
  pinned,
}: ImageActionInput): 'skip' | 'build' | 'not-initialized' {
  const needBuild = rebuild || !imageExists || !pinned;
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
  /** The name to resolve to an Agent - a known agent/harness, or the favorite. */
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
 * CLI args) so that {@link validateSpawn} and {@link planSpawn} can be pure.
 *
 * Every field is `readonly`: the value is complete when the edge hands it over,
 * and the pipeline downstream of it only reads. The one thing that cannot be
 * known before the container runtime is involved - whether the local OmniRoute
 * stack accepts the agent's provider key - is resolved by `prepareLocalStack`,
 * which returns a *new* `SpawnFacts` rather than writing into this one (it used
 * to patch two fields in place after `validateSpawn` had already passed).
 */
export interface SpawnFacts {
  /** The store root, or undefined when no `.e` store was found. */
  readonly root: string | undefined;
  /** The resolved Agent to run (a harness agent; a remote A2A agent never enters the pipeline). */
  readonly agent: HarnessAgent;
  /** The Harness the agent runs. */
  readonly harness: Harness;
  /** Parsed `.e/.env` (secrets resolved by name from here; never baked). */
  readonly storeEnv: Readonly<Record<string, string>>;
  /** The requested `--mcp` servers, already resolved from disk (existence checked). */
  readonly mcpServers: readonly McpServer[];
  /** Per-run `--skill` names (existence checked on disk during gather). */
  readonly perRunSkills: readonly string[];
  /** The agent's baked default skills (`agent.skills`). */
  readonly bakedSkills: readonly string[];
  /** The prompt, joined into a single string. */
  readonly prompt: string;
  /**
   * The store has a local OmniRoute stack (its `compose.yaml` exists). Decides
   * where sidecars are reached (shared egress namespace vs. private network)
   * and whether the provider needs an endpoint key.
   */
  readonly localStackPresent: boolean;
  /** Rebuild every image: true unless `--no-rebuild`. */
  readonly rebuild: boolean;
  /** `--name` run-name override. */
  readonly name?: string;
  /** `-e` env entries. */
  readonly env: readonly string[];
  /** `-p` port publishes. */
  readonly port?: readonly string[];
  /**
   * The host process has a terminal on stdin. An interactive run needs one to
   * attach to; without it (and without {@link headlessTty}) {@link validateSpawn}
   * refuses a promptless spawn instead of hanging in a pipe or CI job.
   */
  readonly stdinIsTty?: boolean;
  /**
   * `E_TTY_HEADLESS`: this spawn has no host TTY (it was started by the `serve`
   * browser terminal), so an interactive run detaches the container's TTY and
   * the parent attaches through the engine API (see `RunOptions.headlessTty`).
   */
  readonly headlessTty?: boolean;
  /** `--rm`. */
  readonly rm?: boolean;
  /** `--keep-worktree`: leave the run's worktree in place after the container exits. */
  readonly keepWorktree?: boolean;
  /**
   * The shared `.e/.env` path when it exists on disk, for env-file layering -
   * or {@link storeEnvFile} when a file stands in for it. Filtered to the
   * plan's whitelist either way.
   */
  readonly baseEnvFile?: string;
  /** The user's `--env-file` path, layered over the base. */
  readonly userEnvFile?: string;
  /**
   * The file read in place of the Store's `.env`: a one-shot run's
   * `--env-file`, or `E_STORE_ENV_FILE` on its sibling (ADR-0016 section 13).
   * Handed on to this run's siblings.
   */
  readonly storeEnvFile?: string;
  /**
   * The `--dir` a sibling gets and the "run `e init` --dir <x>" hint names:
   * the raw `--dir` value, or a one-shot run's Base Store root.
   */
  readonly dirOpt?: string;
  /**
   * Where the run's worktree is created: `E_WORKTREES_DIR` or the platform rule
   * in `runs/worktreesDir.ts`. Resolved once, by the edge - `runSpawn` takes it
   * as given rather than defaulting a second time.
   */
  readonly worktreesDir: string;
  /**
   * The role this run's containers receive as `E_ROLE` (ADR-0013): `parent`
   * for a run the user (or `serve`) started, `child` for a sibling requested
   * through the runtime-broker. Absent -> `parent`.
   */
  readonly role?: RunRole;
  /**
   * Present when this process was started by a parent run's host for a sibling
   * request (the `E_SPAWN_*` markers): the parent to checkpoint and branch
   * from, the network to join, and where to report status.
   */
  readonly sibling?: SiblingSpawn;
  /**
   * Present when something watches this run through a spool without it being
   * a sibling (the `E_SPAWN_REPORT_*` markers set by the A2A facade of
   * `e serve`, ADR-0015): where to report status, `pushed` and the PR/MR URL.
   */
  readonly report?: { spoolDir: string; id: string };
  /** The store's `siblingArtifacts` (`config.json`): what a sibling copies from its parent (ADR-0013). */
  readonly siblingArtifacts: readonly string[];
  /** The store's `maxSiblings` (`config.json`): siblings a run may have in flight at once (ADR-0013). */
  readonly maxSiblings: number;
  /**
   * The store's `verify` (`config.json`): the repository's own check, which
   * gates the run (ADR-0016). Absent means no gate - the run ends on the
   * harness's exit code exactly as it did before.
   */
  readonly verify?: VerifyConfig;
  /** The store's package-cache volume, used only when `verify.cache` opts in. */
  readonly cacheVolume?: string;
  /** The store's `loop` block (`config.json`): the attempt budget and the wall clocks (ADR-0016). */
  readonly loop?: LoopCaps;
  /** The store's `resources` block: container limits for every run (ADR-0016). */
  readonly resources?: ResourceCaps;
  /**
   * The store's `localRuntimes` (`config.json`): a stack with none renders no
   * model-registration service, so bringing it up waits for nothing.
   */
  readonly localRuntimes: readonly LocalRuntime[];
  /** The store's `gitPlatform` (`config.json`): which PR/MR opener a finished run gets, if any. */
  readonly gitPlatform?: GitPlatform;
  /**
   * A one-shot trigger's declared base (ADR-0016 section 13), already
   * through the base rule: the commit the run branches from and the branch
   * its PR targets. Absent, the run cuts from the host's HEAD.
   */
  readonly base?: Readonly<RunBase>;
  /**
   * A one-shot trigger's payload file (`--event`), mounted read-only at
   * `/run/e/event.json` for the agent that wants the whole thing.
   */
  readonly eventFile?: string;
  /**
   * What started a triggered run, or the one its parent inherited (ADR-0016
   * section 9): trailers on every commit, the trigger lines of the PR block.
   * Absent for a manual run.
   */
  readonly provenance?: Readonly<Provenance>;
  /**
   * The Store's `.e/` a Run keeps its harness session in (ADR-0017): the
   * checkout's, never a Base Store's scratch copy. Absent without a Store,
   * and then no Run can be resumed.
   */
  readonly sessionStoreDir?: string;
  /** `e resume`: continue this earlier Run on its own branch (ADR-0017). */
  readonly resume?: Readonly<ResumeRun>;
  /**
   * A run of the one-shot deployment shape (ADR-0016 section 13): `e spawn
   * --trigger`, or a sibling of such a run. It uses a local stack that is
   * already running and never starts one, minting its own endpoint key
   * (`prepareOneShotStack`), and hands the marker on to its siblings.
   */
  readonly oneShotShape?: boolean;
}

/** True when the positional prompt carries anything but whitespace. */
function hasPrompt(prompt: string): boolean {
  return prompt.trim() !== '';
}

/**
 * Decides, purely, whether a run is interactive (the harness TUI) or one-shot
 * (the prompt on the harness's command line). The prompt is the switch, as
 * every user-facing surface documents it: `e spawn <agent> "<prompt>"` runs
 * one-shot, `e spawn <agent>` opens the TUI. No flag takes part: a script
 * that lost its prompt is caught by {@link validateSpawn} (no terminal to
 * attach a TUI to) rather than by an opt-in switch. Callers with no prompt by
 * construction - the browser terminal's headless child (ADR-0014) - stay
 * interactive.
 */
export function isInteractiveRun(facts: Pick<SpawnFacts, 'prompt'>): boolean {
  return !hasPrompt(facts.prompt);
}

/**
 * True when an interactive run has something to attach the harness TUI to:
 * the host's own terminal, or the engine API when `serve` started this spawn
 * headless and will attach through it (`E_TTY_HEADLESS`, ADR-0014).
 */
function hasTerminalForTui(
  facts: Pick<SpawnFacts, 'stdinIsTty' | 'headlessTty'>
): boolean {
  return Boolean(facts.stdinIsTty) || Boolean(facts.headlessTty);
}

/**
 * The pure, fail-fast validation that must pass before the (expensive) model
 * resolution and any build. Throws with a clear message on the first problem:
 *  - a provider protocol the harness does not speak;
 *  - a provider on a harness with no config adapter;
 *  - `--mcp` against a harness with no MCP client (opencode);
 *  - baked or `--skill` skills against a harness that supports none;
 *  - a `-e` that names a role-contract variable (`E_ROLE`, `E_BROKER_URL`);
 *  - no prompt and no terminal (nothing to run one-shot, nothing to attach a TUI to).
 * Server/skill *existence* is checked by the edge during gather (it needs disk).
 */
export function validateSpawn(facts: SpawnFacts): void {
  const { agent, harness } = facts;
  const caps = harnessCapabilities(harness);

  // An interactive run attaches the harness TUI to the host terminal. A
  // script or CI job that lost its prompt has no terminal, so it is refused
  // here instead of hanging in `run -it`. The browser terminal's child has no
  // host TTY by design and says so with E_TTY_HEADLESS (ADR-0014).
  if (isInteractiveRun(facts) && !hasTerminalForTui(facts)) {
    throw new Error(
      'No prompt and no terminal: pass a prompt for a one-shot run, or start `e spawn` from a terminal to open the harness TUI.'
    );
  }

  // A sibling is a child by definition; the two markers must agree.
  if (facts.sibling && (facts.role ?? 'parent') !== 'child') {
    throw new Error(
      `A spawn started for sibling ${facts.sibling.id} must carry E_SPAWN_ROLE=child.`
    );
  }
  // A sibling branches from its parent's checkpoint; a declared base would
  // be a second answer to where it cuts from.
  if (facts.sibling && facts.base) {
    throw new Error(
      `A spawn started for sibling ${facts.sibling.id} branches from its parent; it cannot also declare a base.`
    );
  }
  // A sibling already reports into its parent's spool; a second spool would
  // be two watchers for one run (ADR-0015).
  if (facts.sibling && facts.report) {
    throw new Error(
      `A spawn started for sibling ${facts.sibling.id} cannot also carry the report markers.`
    );
  }

  // A resume continues a session only a resumable harness keeps (ADR-0017),
  // in a Store, on the Run's own branch.
  if (facts.resume) {
    if (!caps.resume) {
      const resumable = resumableHarnessNames();
      throw new Error(
        `Harness "${harness.name}" cannot resume a session: it declares no resumeCommand. e resume supports: ${resumable.length > 0 ? resumable.join(', ') : '(none)'}.`
      );
    }
    if (facts.sessionStoreDir === undefined) {
      throw new Error(
        `Cannot resume ${facts.resume.branch}: there is no Store to keep sessions in (run \`e init\`).`
      );
    }
    if (facts.sibling || facts.base || facts.report) {
      throw new Error(
        `A resumed run continues its own branch (${facts.resume.branch}): it cannot also be a sibling, a watched run or declare a base.`
      );
    }
  }

  // The role contract is the host's to set for every run container (ADR-0013);
  // a user `-e` naming it would only be out-ranked by the host's entry, so it
  // is refused up front instead of silently ignored.
  const reserved = facts.env.filter(isRoleContractEntry);
  if (reserved.length > 0) {
    const keys = reserved.map(entry => entry.split('=', 1)[0]).join(', ');
    throw new Error(
      `Cannot pass -e ${keys}: e sets E_ROLE and E_BROKER_URL for every run container itself (ADR-0013).`
    );
  }

  // The same rule against the third way into a container (#153): an agent
  // provider and an MCP server's requiredEnv are checked when the plan is
  // composed, a user `-e` here.
  for (const entry of facts.env) {
    const key = entry.split('=', 1)[0];
    const reason = NEVER_FORWARDED_ENV[key];
    if (reason) {
      throw new Error(
        `Cannot pass -e ${key}: it is never forwarded to a run container, because ${reason}.`
      );
    }
  }

  validateProviderProtocol(agent.provider, harness);

  if (agent.provider && caps.provider === 'none') {
    throw new Error(
      `Harness "${harness.name}" has no config adapter, so it cannot deliver a provider yet.`
    );
  }

  if (facts.mcpServers.length > 0 && caps.mcp === 'none') {
    throw new Error(
      `Harness "${harness.name}" has no MCP client, so it cannot use --mcp. ` +
        `Use a harness that supports MCP (e.g. claudeCode, codex, or pi).`
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
        `${kinds.join(' or ')} skills.`
    );
  }
}

/**
 * Maps an MCP server's required credentials to {@link ContainerEnv} refs (each a
 * `fromEnv` name) and renders them into `.env` file content via `renderer`,
 * resolving each secret by name and failing loud on a missing one (the shared
 * {@link EnvFileRenderer} owns that resolution). Returns undefined for a
 * credential-free server. Pure - the edge writes the content to a scratch file.
 */
export function renderMcpCredentials(
  server: McpServer,
  renderer: EnvFileRenderer
): string | undefined {
  if (server.requiredEnv.length === 0) return undefined;
  const entries: ContainerEnv[] = server.requiredEnv.map(name => ({
    name,
    fromEnv: name,
  }));
  return renderer.render(entries, `MCP server "${server.name}"`);
}

/**
 * The complete plan for a spawn, as data - every effect the edge will perform,
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
  /**
   * The runtime-broker sidecar (ADR-0013), planned when the run carries the
   * `spawn-brother` skill - baked into the agent or added with `--skill`. The
   * skill is how the agent learns to call the broker, so it is also what
   * brings the broker along; a run without it gets no broker. A `child` run
   * never gets one either: children inherit the parent's broker over the
   * parent's network (ADR-0013, "no new sidecars per child").
   */
  broker?: BrokerPlan;
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
  /**
   * The payload's read-only mount at `/run/e/event.json` (ADR-0016): outside
   * `/workspace`, so it can never ride along in a `commitAll`.
   */
  eventMount?: Mount;
  /**
   * The agent container's `-e` env: the user's `-e`, any config-dir relocation
   * env, then the host-set role contract (`E_ROLE`, `E_BROKER_URL`). A user
   * `-e` on those keys is refused by {@link validateSpawn}; env-files are
   * out-ranked by `-e` in every runtime, so the host's values always land.
   */
  agentEnv: string[];
  /** A runtime-resolved model to pass on the harness command line, when applicable. */
  runtimeModel?: string;
  /**
   * The session the Run keeps on the host (ADR-0017), as the record's
   * Run-independent part: planned for a harness that can resume, in a Store,
   * and never for a child, whose delivery is the merge-back.
   */
  session?: RunSessionInit;
  /**
   * The base `.e/.env` key whitelist (Zone 2): the only keys a container may
   * receive - the provider's `apiKeyEnv`/`baseUrlEnv`, the `requiredEnv` of every
   * selected MCP server (sidecar and remote), and the template's global base-URL
   * lines. Everything else in `.e/.env` is filtered out at execute, so an
   * unrelated secret never reaches the untrusted harness agent.
   */
  baseEnvWhitelist: string[];
}

/**
 * Composes the whole {@link SpawnPlan} purely, given the gathered {@link
 * SpawnFacts} and the already-resolved model (undefined for a default agent). All
 * the branching that used to live inline in the spawn action - provider delivery,
 * MCP sidecar vs. remote vs. flag vs. file, the config overlay, the derived image,
 * skill mounts, and every credential env-file - is decided here, so the whole
 * thing is testable without a runtime, a container, or the network. Throws on a
 * missing credential (via {@link renderMcpCredentials}/{@link EnvFileRenderer}).
 */
/**
 * Formats {@link ContainerEnv} entries as the `-e NAME=value` argv the engine
 * takes. This is the edge: an adapter says which variable a harness needs set
 * to what, and the spelling is decided here, once, next to everything else
 * that goes on the container's command line.
 *
 * A `fromEnv` reference has no `-e` form - the host value would have to be
 * read first - and no adapter produces one for a config overlay, so it is a
 * programming error rather than a case to render.
 */
function containerEnvArgs(entries: readonly ContainerEnv[]): string[] {
  return entries.map(entry => {
    if (!('value' in entry)) {
      throw new Error(
        `Config-overlay env "${entry.name}" references the host variable "${entry.fromEnv}"; only literal values can go on the command line.`
      );
    }
    return `${entry.name}=${entry.value}`;
  });
}

export function planSpawn(facts: SpawnFacts): SpawnPlan {
  const { agent, harness, storeEnv, root } = facts;
  // One renderer, bound to the store's secrets, for every credential env-file this
  // spawn writes - the provider's and each MCP server's (ADR-0008).
  const envRenderer = new EnvFileRenderer(name => storeEnv[name]);

  // Provider delivery (env harness → runtime env; file harness → baked config).
  let delivery: ProviderDelivery | undefined;
  let providerEnvContent: string | undefined;
  if (agent.provider && harness.adapter) {
    delivery = planProviderDelivery(storeEnv, harness.adapter, agent.provider);
    providerEnvContent = envRenderer.render(
      delivery.runtimeEnv,
      'Provider API key'
    );
  }

  // The base `.e/.env` whitelist (Zone 2): which keys may reach a container. The
  // template's global base-URL lines are always allowed; the provider's key and
  // base-URL names, and every selected MCP server's required env, are added
  // below. Everything else in `.e/.env` is filtered out at execute time - an
  // unrelated secret stays in the file (the user's own shell reads it) but never
  // enters the untrusted harness container.
  const allowedEnvKeys = new Set<string>(GLOBAL_BASE_URL_ENV);
  const allowEnvOrRefuse = (key: string, declaredBy: string) => {
    const reason = NEVER_FORWARDED_ENV[key];
    if (reason) {
      throw new Error(
        `${declaredBy} declares "${key}", which is never forwarded to a run container: ${reason}. Use a different variable.`
      );
    }
    allowedEnvKeys.add(key);
  };
  if (agent.provider) {
    const declaredBy = `Agent "${agent.name}"`;
    allowEnvOrRefuse(agent.provider.apiKeyEnv, declaredBy);
    if (agent.provider.baseUrlEnv)
      allowEnvOrRefuse(agent.provider.baseUrlEnv, declaredBy);
  }

  // MCP: split by transport, render credentials, decide the delivery form.
  const sidecars: SidecarPlan[] = [];
  const sidecarCredentials: Record<string, string> = {};
  const remoteCredentials: string[] = [];
  let mcpArgs: string[] = [];
  let configOverlay: ConfigOverlayDelivery | undefined;
  // The keys this run may carry, for a harness that keeps them out of its
  // agent's shell (Codex's `exclude`): its own and the provider's.
  const secretEnv = [
    ...harness.requiredEnv,
    ...(agent.provider ? [agent.provider.apiKeyEnv] : []),
  ];
  const baseConfig = delivery?.bakedConfig?.file.content ?? '';
  if (facts.mcpServers.length > 0) {
    const selection = planMcpSelection(
      facts.mcpServers,
      facts.localStackPresent === true,
      facts.port
        ?.map(value => Number(value.split(':').pop()))
        .filter(Number.isFinite)
    );
    // Every selected server's required env passes the base filter: a sidecar's
    // via its own env-file, a remote server's via the agent's env-files.
    for (const server of [
      ...selection.containerServers,
      ...selection.remoteServers,
    ]) {
      for (const key of server.requiredEnv) {
        allowEnvOrRefuse(key, `MCP server "${server.name}"`);
      }
    }
    for (const server of selection.containerServers) {
      sidecars.push({
        alias: server.name,
        image: imageTag('mcp', server.name),
        port: selection.ports.get(server.name)!,
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
      baseConfig,
      secretEnv
    );
    if (mcp.form === 'flag') {
      mcpArgs = mcp.args;
    } else if (mcp.form === 'file') {
      configOverlay = mcp.overlay;
    }
  }
  // A harness that needs its config on every run gets it without --mcp too:
  // Codex, whose secret policy a default agent bakes nowhere (#206).
  const adapter = harness.adapter;
  if (
    configOverlay === undefined &&
    adapter?.kind === 'file' &&
    adapter.overlayEveryRun &&
    adapter.planConfigOverlay
  ) {
    configOverlay = adapter.planConfigOverlay(baseConfig, [], secretEnv);
  }

  // Per-run skill mounts (baked skills are handled by the derived image below).
  const skillMounts: Mount[] = [];
  if (facts.perRunSkills.length > 0 && harness.skillsDir) {
    for (const name of facts.perRunSkills) {
      skillMounts.push(
        skillMountSpec(skillDir(name, root), harness.skillsDir, name)
      );
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
    // The derived COPY layers hand ownership back to the user the harness base
    // image ends with (the non-root default; see renderDerivedDockerfile).
    runtimeUser: harness.dockerfile.runtimeUser,
  });

  // The role contract (ADR-0013): `E_ROLE` and `E_BROKER_URL` as `-e` entries,
  // never baked into an image. The broker is reached like any sidecar - on
  // loopback in the shared egress namespace, by alias on a private network.
  const roleContract = roleEnv(
    facts.role ?? 'parent',
    brokerUrl(facts.localStackPresent === true)
  );

  const wantsSiblings = [...facts.bakedSkills, ...facts.perRunSkills].includes(
    SPAWN_BROTHER_SKILL
  );
  const broker: BrokerPlan | undefined =
    wantsSiblings && (facts.role ?? 'parent') !== 'child'
      ? defaultBrokerPlan()
      : undefined;

  return {
    delivery,
    providerEnvContent,
    baseEnvWhitelist: [...allowedEnvKeys],
    broker,

    sidecars,
    sidecarCredentials,
    remoteCredentials,
    mcpArgs,
    configOverlay,
    agentImagePlan,
    skillMounts,
    eventMount: facts.eventFile
      ? { host: facts.eventFile, container: EVENT_MOUNT_PATH, ro: true }
      : undefined,
    agentEnv: [
      ...facts.env,
      ...containerEnvArgs(configOverlay?.env ?? []),
      ...roleContract,
    ],
    runtimeModel: delivery?.runtimeModel,
    session: planSession(facts),
  };
}

/** The session part of {@link planSpawn} (ADR-0017). */
function planSession(facts: SpawnFacts): RunSessionInit | undefined {
  const { agent, harness } = facts;
  if (!harnessCapabilities(harness).resume) return undefined;
  const provider = sessionProvider(agent.provider);
  if (facts.sessionStoreDir === undefined) return undefined;
  if ((facts.role ?? 'parent') === 'child' || facts.sibling) return undefined;
  return {
    agent: agent.name,
    harness: harness.name,
    harnessVersion: harness.version,
    ...(provider ? { provider } : {}),
    mcp: facts.mcpServers.map(server => server.name),
    skills: [...facts.perRunSkills],
  };
}
