import fs from 'fs';
import path from 'path';
import type { Git } from './git/index';
import type { ContainerRuntime, Mount } from './runtime/index';
import { runSpawn, type RunSpawnResult, type SidecarPlan } from './runSpawn';
import {
  decideImageAction,
  orderEnvFiles,
  type SpawnFacts,
  type SpawnPlan,
} from './spawnPlan';
import { RunScratch } from './runScratch';
import { writeIfAbsent } from './scaffold';
import { harnessDir, agentDir, mcpDir, skillDir, isInitialized } from './store';

/** The effect-performing collaborators the executor drives. */
export interface ExecuteSpawnDeps {
  git: Git;
  runtime: ContainerRuntime;
  scratch: RunScratch;
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
  scratch: RunScratch,
): string {
  const { harness, root, rebuild } = facts;
  // Preserve the short-circuit: with --rebuild the decision is always `build`,
  // so skip the (otherwise wasted) image-inspect probe.
  const imageExists = !rebuild && runtime.imageExists(harness.imageTag);
  const initialized = root !== undefined && isInitialized(harness.name, root);
  const action = decideImageAction({ rebuild, imageExists, initialized });
  if (action === 'not-initialized') {
    throw new Error(
      `Harness "${harness.name}" is not initialized. Run \`e init\`${facts.dirOpt ? ` --dir ${facts.dirOpt}` : ''} first.`,
    );
  }
  if (action === 'build') runtime.build(harness.imageTag, harnessDir(harness.name, root));

  let tag = harness.imageTag;
  const agentImagePlan = plan.agentImagePlan;
  if (agentImagePlan) {
    const dir = agentDir(facts.agent.name, root);
    for (const file of agentImagePlan.files) {
      writeIfAbsent(dir, path.join(dir, file.fileName), file.content);
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
  return tag;
}

/**
 * Performs the effects a {@link SpawnPlan} names (ADR-0008): the preflight guards
 * (a git repo, foreground), the image builds (before any worktree, so a build
 * failure never leaves orphan scaffolding — ADR-0005), materializing every
 * rendered file into {@link RunScratch} and wiring the resulting paths, then
 * handing the run's lifecycle to {@link runSpawn}. Returns the run's result, or a
 * pre-run error result when a guard fails.
 */
export async function executeSpawn(
  facts: SpawnFacts,
  plan: SpawnPlan,
  deps: ExecuteSpawnDeps,
): Promise<RunSpawnResult> {
  const { git, runtime, scratch } = deps;

  if (!git.isRepo()) {
    return {
      ran: false,
      exitCode: 1,
      error:
        'e spawn must be run inside a git repository — every run needs an isolated worktree.',
    };
  }
  // A run's worktree is removed as soon as the container returns; a detached run
  // would tear it down under a still-running agent, so a run must run foreground.
  if (facts.attach === false) {
    return {
      ran: false,
      exitCode: 1,
      error:
        'Detached runs (--no-attach) are not supported with per-run worktrees; run in the foreground (the default).',
    };
  }

  const imageTag = buildImages(facts, plan, runtime, scratch);

  // Materialize every rendered file into scratch and wire the resulting paths.
  // Base `.e/.env` first, then the user's --env-file, then remote-MCP and provider
  // credentials layered last (each container gets its own copy at run time).
  const envFiles = orderEnvFiles(facts.baseEnvFile, facts.userEnvFile);
  for (const content of plan.remoteCredentials) {
    envFiles.push(scratch.file('remote-mcp.env', content));
  }
  if (plan.providerEnvContent) {
    envFiles.push(scratch.file('provider.env', plan.providerEnvContent));
  }

  // A sidecar that needs credentials gets its own env-file (never the agent's).
  const sidecars: SidecarPlan[] = plan.sidecars.map((sc) => {
    const creds = plan.sidecarCredentials[sc.alias];
    return creds ? { ...sc, envFile: [scratch.file(`${sc.alias}.env`, creds)] } : sc;
  });

  // The Codex config overlay and the per-run skill mounts are both read-only
  // mounts outside /workspace, delivered together.
  const configMounts: Mount[] = [];
  if (plan.configOverlay) {
    const hostFile = scratch.file(
      plan.configOverlay.file.fileName,
      plan.configOverlay.file.content,
    );
    configMounts.push({ host: hostFile, container: plan.configOverlay.mountTo, ro: true });
  }
  configMounts.push(...plan.skillMounts);

  return runSpawn(
    { git, runtime },
    {
      agent: facts.agent,
      harness: facts.harness,
      prompt: facts.prompt,
      imageTag,
      model: plan.runtimeModel,
      name: facts.name,
      runOptions: {
        attach: facts.attach,
        rm: facts.rm,
        port: facts.port,
        env: plan.agentEnv,
        envFile: envFiles,
      },
      sidecars,
      mcpArgs: plan.mcpArgs,
      configMounts,
    },
  );
}
