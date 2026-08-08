/**
 * Pure decisions behind the `spawn` command. The command action stays a thin
 * edge that performs the I/O (filesystem, runtime) and effects (`process.exit`,
 * `console`); the branching logic that decides *what* to do lives here so it can
 * be tested directly, without building an image or running a container.
 */

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
