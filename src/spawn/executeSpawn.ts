import fs from 'fs';
import path from 'path';
import type { Git } from '../git/index.js';
import type { PullRequest } from '../github/index.js';
import type { GitPlatform } from '../store/config.js';
import type { ContainerRuntime, Mount, RunOptions } from '../runtime/index.js';
import {
  runSpawn,
  type RunSpawnResult,
  type SidecarPlan,
} from '../runs/runSpawn.js';
import { filterEnvContent } from '../utils/dotenv.js';
import {
  decideImageAction,
  isInteractiveRun,
  orderEnvFiles,
  type SpawnFacts,
  type SpawnPlan,
} from './spawnPlan.js';
import { RunScratch } from '../runs/runScratch.js';
import { writeIfAbsent } from '../scaffold.js';
import {
  harnessDir,
  agentDir,
  brokerDir,
  mcpDir,
  skillDir,
} from '../store/paths.js';
import { isInitialized } from '../store/config.js';
import { Env } from '../utils/env.js';
import {
  spawnSiblingProcess,
  type SiblingLauncher,
} from '../runs/runSiblings.js';
import { renderBrokerFiles } from '../init/renderBroker.js';
import { findAgent, isRemoteAgent } from '../agent/index.js';
import { remoteSiblingProcess } from '../a2a/remoteSibling.js';
import { A2aClient } from '../a2a/client.js';

/**
 * The production sibling launcher (ADR-0013, ADR-0015): a request for a
 * harness agent becomes a child `e spawn` process; one for a remote A2A agent
 * (`transport: "a2a"` in its `agent.json`) is answered in-process by the A2A
 * client, its headers' `${VAR}` references resolved from the store env. An
 * unknown agent is left to the child process, whose error lands in the log.
 */
export function productionSiblingLauncher(
  root: string | undefined,
  storeEnv: Record<string, string>
): SiblingLauncher {
  return launch => {
    let agent;
    try {
      agent = findAgent(launch.request.agent, root);
    } catch {
      agent = undefined;
    }
    if (agent && isRemoteAgent(agent)) {
      return remoteSiblingProcess({
        agent,
        request: launch.request,
        spoolDir: launch.spoolDir,
        storeEnv,
        client: new A2aClient(),
      });
    }
    return spawnSiblingProcess(launch);
  };
}

/** The effect-performing collaborators the executor drives. */
export interface ExecuteSpawnDeps {
  git: Git;
  runtime: ContainerRuntime;
  scratch: RunScratch;
  /** Optional PR/MR opener (present only when the store has a platform). */
  pullRequest?: PullRequest;
  /** The configured git platform, forwarded to `runSpawn`. */
  gitPlatform?: GitPlatform;
  /** A cancel (SIGTERM), forwarded to `runSpawn` (ADR-0015). */
  abort?: AbortSignal;
  /**
   * Starts one sibling for the run's consumer; defaults to the production
   * launcher (a child `e spawn` process, or the in-process A2A client for a
   * remote agent). Tests pass a scripted one.
   */
  launchSibling?: SiblingLauncher;
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
  runtime: ContainerRuntime,
  scratch: RunScratch
): string {
  const { harness, root, rebuild } = facts;
  // Preserve the short-circuit: with --rebuild the decision is always `build`,
  // so skip the (otherwise wasted) image-inspect probe.
  const imageExists = !rebuild && runtime.imageExists(harness.imageTag);
  const initialized = root !== undefined && isInitialized(harness.name, root);
  const action = decideImageAction({ rebuild, imageExists, initialized });
  if (action === 'not-initialized') {
    throw new Error(
      `Harness "${harness.name}" is not initialized. Run \`e init\`${facts.dirOpt ? ` --dir ${facts.dirOpt}` : ''} first.`
    );
  }
  if (action === 'build') {
    // The base harness image is self-contained: the Dockerfile installs npm,
    // then runs `npx skills@latest add <collection> …` for each declared
    // collection, so the harness dir alone is the whole build context.
    runtime.build(harness.imageTag, harnessDir(harness.name, root));
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
    if (rebuild || !runtime.imageExists(tag)) {
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

  // The Codex config overlay and the per-run skill mounts are both read-only
  // mounts outside /workspace, delivered together.
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

  // A sibling (ADR-0013) joins its parent's private run network so the
  // `runtime-broker` alias resolves for it too; in the shared egress
  // namespace everyone is on loopback and no network is joined.
  const sibling = facts.sibling;
  // One-shot or TUI follows the prompt (see isInteractiveRun).
  const interactive = isInteractiveRun(facts);
  const runOptions: RunOptions = {
    interactive,
    headlessTty: facts.headlessTty,
    rm: facts.rm,
    port: facts.port,
    env: plan.agentEnv,
    envFile: envFiles,
    netns: facts.localStackPresent ? 'e-egress' : undefined,
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
      role: facts.role,
      broker: plan.broker,
      maxSiblings: facts.maxSiblings,
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
        passthroughArgs: [
          ...(facts.dirOpt ? ['--dir', facts.dirOpt] : []),
          ...(facts.userEnvFile ? ['--env-file', facts.userEnvFile] : []),
        ],
        passthroughEnv: { [Env.RUNTIME_VAR]: runtime.command },
      },
    }
  );
}
