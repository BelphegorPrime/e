import fs from 'fs';
import path from 'path';
import type { Git } from '../../ports/git/index.js';
import type { PullRequest } from '../../ports/github/index.js';
import type { GitPlatform } from '../../core/store/config.js';
import type {
  ContainerRunner,
  Mount,
  RunOptions,
} from '../../ports/runtime/index.js';
import { runSpawn, type RunSpawnResult } from '../runs/runSpawn.js';
import type { SidecarPlan } from '../sidecarPlan.js';
import { filterEnvContent, parseDotenv } from '../../shared/utils/dotenv.js';
import { NEVER_FORWARDED_ENV } from '../../core/harness/renderEnvTemplate.js';
import {
  decideImageAction,
  isInteractiveRun,
  orderEnvFiles,
  type SpawnFacts,
  type SpawnPlan,
} from './spawnPlan.js';
import { RunScratch } from '../runs/runScratch.js';
import { writeIfAbsent } from '../../shared/scaffold.js';
import {
  eBaseDir,
  harnessDir,
  dockerfilePath,
  agentDir,
  brokerDir,
  mcpDir,
  skillDir,
} from '../../core/store/paths.js';
import { isInitialized } from '../../core/store/config.js';
import {
  checkPin,
  harnessPin,
  pinBuildArgs,
  pinRebuildMessage,
  unpinnedAfterBuildMessage,
} from '../../core/harness/pin.js';
import { log } from '../../shared/utils/log.js';
import { errorMessage } from '../../shared/utils/errors.js';
import { openRunLedger, type RunLedger } from '../queue/ledger.js';
import { Env } from '../../shared/utils/env.js';
import { SPAWN_FLAGS } from '../../shared/spawnArgs.js';
import { EGRESS_CONTAINER } from '../../shared/constants.js';
import type { ChildLauncher } from '../runs/childRun.js';
import { productionSiblingLauncher } from '../a2a/siblingLauncher.js';
import { renderBrokerFiles } from '../../sidecars/broker/render.js';

/** The effect-performing collaborators the executor drives. */
export interface ExecuteSpawnDeps {
  git: Git;
  runtime: ContainerRunner;
  scratch: RunScratch;
  /** Optional PR/MR opener (present only when the store has a platform). */
  pullRequest?: PullRequest;
  /** The configured git platform, forwarded to `runSpawn`. */
  gitPlatform?: GitPlatform;
  /** A cancel (SIGTERM), forwarded to `runSpawn` (ADR-0015). */
  abort?: AbortSignal;
  /** This run's ledger entry; defaults to the claimed one or a new manual one. */
  ledger?: RunLedger;
  /**
   * Starts one sibling for the run's consumer; defaults to the production
   * launcher (a child `e spawn` process, or the in-process A2A client for a
   * remote agent). Tests pass a scripted one.
   */
  launchSibling?: ChildLauncher;
}

/**
 * Builds the primary image (the harness base, or a derived agent image on top)
 * and every sidecar image before any worktree exists (ADR-0005), returning the
 * tag the run executes. Renders the derived agent's files under `.e/agents/<name>/`
 * without clobbering a hand edit (ADR-0004); baked skills are copied into a
 * scratch build context because they are file trees, not rendered strings.
 */
function buildImages(
  facts: SpawnFacts,
  plan: SpawnPlan,
  runtime: ContainerRunner,
  scratch: RunScratch
): string {
  const { harness, root, rebuild } = facts;
  const pin = harnessPin(harness);
  const buildArgs = pinBuildArgs(pin);
  // Preserve the short-circuit: when rebuilding (the default) the decision is
  // always `build`, so skip the (otherwise wasted) image-inspect probe. A
  // rebuild is a plain build, so an unchanged Dockerfile is all cache hits.
  const labels = rebuild ? undefined : runtime.imageLabels(harness.imageTag);
  const drift = labels === undefined ? undefined : checkPin(labels, pin);
  const initialized = root !== undefined && isInitialized(harness.name, root);
  const action = decideImageAction({
    rebuild,
    imageExists: labels !== undefined,
    initialized,
    pinned: drift === undefined || drift.status === 'match',
  });
  if (action === 'not-initialized') {
    throw new Error(
      `Harness "${harness.name}" is not initialized. Run \`e init\`${facts.dirOpt ? ` --dir ${facts.dirOpt}` : ''} first.`
    );
  }
  if (action === 'build') {
    // Announced and done here, before any worktree (ADR-0005), rather than
    // refused with a demand for --rebuild: a cron trigger has nobody to type it.
    if (drift && drift.status !== 'match') {
      log.info(pinRebuildMessage(harness.imageTag, drift, pin));
    }
    // The base harness image is self-contained: the Dockerfile installs the
    // pinned package, then the skills collections, so the harness dir alone
    // is the whole build context.
    runtime.build(harness.imageTag, harnessDir(harness.name, root), {
      buildArgs,
    });
    // One build per spawn, never a loop: a Dockerfile that ignores the build
    // args yields the same image again, so the abort names the remedy.
    const built = checkPin(runtime.imageLabels(harness.imageTag) ?? {}, pin);
    if (built.status !== 'match') {
      throw new Error(
        unpinnedAfterBuildMessage(
          harness.imageTag,
          dockerfilePath(harness.name, root),
          built,
          pin
        )
      );
    }
  }

  let tag = harness.imageTag;
  const agentImagePlan = plan.agentImagePlan;
  if (agentImagePlan) {
    const dir = agentDir(facts.agent.name, root);
    for (const file of agentImagePlan.files) {
      const filePath = path.join(dir, file.fileName);
      writeIfAbsent(dir, filePath, file.content);
    }
    tag = agentImagePlan.imageTag;
    // The derived image inherits the base's labels and is otherwise never
    // rebuilt when the base is, which would leave exactly the agents that
    // run unattended outside the pin: a rebuilt base rebuilds it too.
    const derivedLabels = rebuild ? undefined : runtime.imageLabels(tag);
    const derivedDrift =
      derivedLabels === undefined ? undefined : checkPin(derivedLabels, pin);
    if (
      action === 'build' ||
      derivedDrift === undefined ||
      derivedDrift.status !== 'match'
    ) {
      if (derivedDrift && derivedDrift.status !== 'match') {
        log.info(pinRebuildMessage(tag, derivedDrift, pin));
      }
      if (agentImagePlan.skillNames.length === 0) {
        // No baked skills: the agent dir is the whole build context.
        runtime.build(tag, dir);
      } else {
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
  }

  for (const sc of plan.sidecars) {
    if (rebuild || !runtime.imageExists(sc.image)) {
      runtime.build(sc.image, mcpDir(sc.alias, root));
    }
  }

  // The runtime-broker's build context is seeded on demand (never clobbering
  // a hand edit), so a store initialized before the broker existed still
  // works; `e init` seeds the same files.
  if (plan.broker) {
    const dir = brokerDir(root);
    for (const [fileName, content] of Object.entries(renderBrokerFiles())) {
      writeIfAbsent(dir, path.join(dir, fileName), content);
    }
    if (rebuild || !runtime.imageExists(plan.broker.image)) {
      runtime.build(plan.broker.image, dir);
    }
  }
  return tag;
}

/**
 * The `e spawn` arguments every sibling inherits from this invocation: the
 * same store and the same user env-file. And `--no-rebuild`: this run built
 * its images a moment ago, so a sibling's rebuild would repeat the same cache
 * hits once per sibling. It still builds whatever is missing or off the pin.
 */
export function siblingPassthroughArgs(
  facts: Pick<SpawnFacts, 'dirOpt' | 'userEnvFile'>
): string[] {
  return [
    ...(facts.dirOpt ? [SPAWN_FLAGS.dir, facts.dirOpt] : []),
    ...(facts.userEnvFile ? [SPAWN_FLAGS.envFile, facts.userEnvFile] : []),
    SPAWN_FLAGS.noRebuild,
  ];
}

/**
 * Performs the effects a {@link SpawnPlan} names (ADR-0008): the preflight guards
 * (a git repo, foreground), the image builds (before any worktree, so a build
 * failure never leaves orphan scaffolding - ADR-0005), materializing every
 * rendered file into {@link RunScratch} and wiring the resulting paths, then
 * handing the run's lifecycle to {@link runSpawn}. Returns the run's result, or a
 * pre-run error result when a guard fails.
 */
export async function executeSpawn(
  facts: SpawnFacts,
  plan: SpawnPlan,
  deps: ExecuteSpawnDeps
): Promise<RunSpawnResult> {
  // Opened first, so a run that dies in a preflight guard or an image build -
  // before `runSpawn` could say so - still ends its ledger entry, and a
  // claimed queue request never leaves its slot held (ADR-0016 section 6).
  const ledger =
    deps.ledger ??
    openRunLedger({
      storeDir: facts.root !== undefined ? eBaseDir(facts.root) : undefined,
      agent: facts.agent.name,
    });
  const failed = (error: string, exitCode?: number): void =>
    ledger.patch({
      state: 'failed',
      error,
      ...(exitCode !== undefined ? { exitCode } : {}),
      endedAt: new Date().toISOString(),
    });
  try {
    const result = await executeSpawnWith(facts, plan, deps, ledger);
    if (!result.ran && result.error) failed(result.error, result.exitCode);
    return result;
  } catch (err) {
    failed(errorMessage(err));
    throw err;
  }
}

async function executeSpawnWith(
  facts: SpawnFacts,
  plan: SpawnPlan,
  deps: ExecuteSpawnDeps,
  ledger: RunLedger
): Promise<RunSpawnResult> {
  const { git, runtime, scratch } = deps;

  if (!git.isRepo()) {
    return {
      ran: false,
      exitCode: 1,
      error:
        'e spawn must be run inside a git repository - every run needs an isolated worktree.',
    };
  }
  // A run's worktree is removed as soon as the container returns.
  const imageTag = buildImages(facts, plan, runtime, scratch);

  // Materialize every rendered file into scratch and wire the resulting paths.
  // The base `.e/.env` comes first, filtered to the run's declared keys (Zone 2:
  // the provider's and MCP servers' env refs plus the template's global base
  // URLs). Unknown keys stay in `.e/.env` - the user's own shell keeps reading
  // them - but never reach a container. Then the user's --env-file, then
  // remote-MCP and provider credentials layered last (each container gets its
  // own copy at run time).
  // A user's `--env-file` is copied into the container verbatim, so it is the
  // one channel the plan's own refusal cannot see. The rule holds here too
  // (#153): the file is read and the run refused, never quietly stripped.
  if (facts.userEnvFile !== undefined) {
    const declared = Object.keys(
      parseDotenv(fs.readFileSync(facts.userEnvFile, 'utf8'))
    );
    const refused = declared.find(key => NEVER_FORWARDED_ENV[key]);
    if (refused) {
      return {
        ran: false,
        exitCode: 1,
        error: `--env-file ${facts.userEnvFile} declares ${refused}, which is never forwarded to a run container: ${NEVER_FORWARDED_ENV[refused]}.`,
      };
    }
  }

  const baseEnvPath =
    facts.baseEnvFile === undefined
      ? undefined
      : scratch.file(
          'base-env.env',
          filterEnvContent(
            fs.readFileSync(facts.baseEnvFile, 'utf8'),
            plan.baseEnvWhitelist
          )
        );

  const envFiles = orderEnvFiles(baseEnvPath, facts.userEnvFile);
  for (const content of plan.remoteCredentials) {
    envFiles.push(scratch.file('remote-mcp.env', content));
  }
  if (plan.providerEnvContent) {
    envFiles.push(scratch.file('provider.env', plan.providerEnvContent));
  }

  // A sidecar that needs credentials gets its own env-file (never the agent's).
  const sidecars: SidecarPlan[] = plan.sidecars.map(sc => {
    const creds = plan.sidecarCredentials[sc.alias];
    return creds
      ? { ...sc, envFile: [scratch.file(`${sc.alias}.env`, creds)] }
      : sc;
  });

  // The Codex config overlay, the per-run skill mounts and a one-shot
  // payload are all read-only mounts outside /workspace, delivered together.
  const configMounts: Mount[] = [];
  if (plan.configOverlay) {
    const hostFile = scratch.file(
      plan.configOverlay.file.fileName,
      plan.configOverlay.file.content
    );
    configMounts.push({
      host: hostFile,
      container: plan.configOverlay.mountTo,
      ro: true,
    });
  }
  configMounts.push(...plan.skillMounts);
  if (plan.eventMount) configMounts.push(plan.eventMount);

  // A sibling (ADR-0013) joins its parent's private run network so the
  // `runtime-broker` alias resolves for it too; in the shared egress
  // namespace everyone is on loopback and no network is joined.
  const sibling = facts.sibling;
  // One-shot or TUI follows the prompt (see isInteractiveRun).
  const interactive = isInteractiveRun(facts);
  const runOptions: RunOptions = {
    // Container limits apply to every run, interactive included: a manual
    // spawn can take the host down exactly as easily as a triggered one.
    ...(facts.resources?.memory !== undefined
      ? { memory: facts.resources.memory }
      : {}),
    ...(facts.resources?.cpus !== undefined
      ? { cpus: facts.resources.cpus }
      : {}),
    ...(facts.resources?.pidsLimit !== undefined
      ? { pidsLimit: facts.resources.pidsLimit }
      : {}),
    interactive,
    headlessTty: facts.headlessTty,
    rm: facts.rm,
    port: facts.port,
    env: plan.agentEnv,
    envFile: envFiles,
    netns: facts.localStackPresent ? EGRESS_CONTAINER : undefined,
    networks:
      sibling?.parent.network && !facts.localStackPresent
        ? [sibling.parent.network]
        : undefined,
  };

  return runSpawn(
    { git, runtime, pullRequest: deps.pullRequest },
    {
      agent: facts.agent,
      name: facts.name,
      harness: facts.harness,
      prompt: facts.prompt,
      interactive,
      model: plan.runtimeModel,
      mcpArgs: plan.mcpArgs,
      gitPlatform: deps.gitPlatform,
      imageTag,
      runOptions,
      sidecars,
      configMounts,
      keepWorktree: facts.keepWorktree,
      worktreesDir: facts.worktreesDir,
      base: facts.base,
      ledger,
      role: facts.role,
      broker: plan.broker,
      maxSiblings: facts.maxSiblings,
      verify: facts.verify,
      cacheVolume: facts.cacheVolume,
      loop: facts.loop,
      parent: sibling
        ? {
            worktreePath: sibling.parent.worktreePath,
            branch: sibling.parent.branch,
            artifacts: facts.siblingArtifacts,
          }
        : undefined,
      sibling: sibling
        ? { spoolDir: sibling.spoolDir, id: sibling.id }
        : undefined,
      report: facts.report,
      abort: deps.abort,
      // What every sibling `e spawn` inherits from this invocation: the same
      // store, the same user env-file, the same container engine.
      siblingHost: {
        launch:
          deps.launchSibling ??
          productionSiblingLauncher(facts.root, facts.storeEnv),
        passthroughArgs: siblingPassthroughArgs(facts),
        passthroughEnv: {
          [Env.RUNTIME_VAR]: runtime.engine,
          // A one-shot run's secrets, which its Base Store has no `.env` for.
          ...(facts.storeEnvFile
            ? { [Env.STORE_ENV_FILE_VAR]: facts.storeEnvFile }
            : {}),
        },
      },
    }
  );
}
